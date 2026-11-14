#!/usr/bin/env node
/**
 * Build the WebAssembly MP3 encoder and install it under `vendor/audiobox/`.
 *
 *   node tools/build-mp3-wasm.mjs           build, verify, install, record hashes
 *   node tools/build-mp3-wasm.mjs --check   verify the installed artefact only
 *
 * The crate in `encoder/` wraps the vendored `audiobox` 0.5.1 source (MIT, see
 * `vendor/audiobox/NOTICE.md`) in a tiny C ABI; the resulting `.wasm` is what the
 * browser loads, so the file is committed rather than built at deploy time.
 *
 * `--check` needs no Rust toolchain: it re-hashes every input that decides the
 * binary and compares the result with `vendor/audiobox/build-info.json`, so a
 * stale artefact or a source edit that was never rebuilt fails loudly in CI.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'wasm32-unknown-unknown';
const CRATE = 'encoder/Cargo.toml';
const BUILT = resolve(ROOT, 'encoder/target', TARGET, 'release/recorder_mp3_encoder.wasm');
const INSTALLED = resolve(ROOT, 'vendor/audiobox/mp3-encoder.wasm');
const BUILD_INFO = resolve(ROOT, 'vendor/audiobox/build-info.json');

/**
 * Paths whose contents decide the binary: the bridge and the vendored crate.
 * `target/` never appears here, so a stale build directory cannot leak in.
 */
const SOURCE_ROOTS = [
  'encoder/Cargo.toml',
  'encoder/Cargo.lock',
  'encoder/src',
  'vendor/audiobox-0.5.1/Cargo.toml',
  'vendor/audiobox-0.5.1/src',
];

/** Exports the app relies on; a binary missing one of them fails at load time. */
const REQUIRED_EXPORTS = [
  'memory',
  'abx_input',
  'abx_encode',
  'abx_output_ptr',
  'abx_output_len',
  'abx_error_ptr',
  'abx_error_len',
];

/**
 * Expand a file or directory (recursively) into a sorted list of absolute paths.
 *
 * @param {string} path project-relative path
 * @returns {string[]}
 */
function walk(path) {
  const absolute = resolve(ROOT, path);
  const stats = statSync(absolute);
  if (stats.isFile()) return [absolute];
  return readdirSync(absolute)
    .sort()
    .flatMap((entry) => walk(join(path, entry)));
}

/**
 * SHA-256 of every source file, path included, in a stable order.
 *
 * @returns {{ sha256: string, files: number }}
 */
function hashSources() {
  const files = SOURCE_ROOTS.flatMap((root) => walk(root)).sort();
  if (files.length === 0) throw new Error('No encoder sources were found');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(ROOT, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

/**
 * Reject a binary that does not expose the bridge ABI, and describe it.
 *
 * @param {string} path
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
async function inspect(path) {
  const bytes = readFileSync(path);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const missing = REQUIRED_EXPORTS.filter((name) => {
    const exported = instance.exports[name];
    return name === 'memory'
      ? !(exported instanceof WebAssembly.Memory)
      : typeof exported !== 'function';
  });
  if (missing.length > 0) {
    throw new Error(`${relative(ROOT, path)} is missing the exports: ${missing.join(', ')}`);
  }
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Compile the bridge crate for WebAssembly with the release profile. */
function build() {
  console.log(`Building ${CRATE} for ${TARGET}…`);
  execFileSync(
    'cargo',
    ['build', '--release', '--target', TARGET, '--manifest-path', resolve(ROOT, CRATE)],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (!existsSync(BUILT)) throw new Error(`cargo reported success but ${BUILT} does not exist`);
}

/** @param {string} command @returns {string} */
function version(command) {
  try {
    return execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  const artifact = await inspect(INSTALLED);
  const sources = hashSources();
  const recorded = existsSync(BUILD_INFO) ? JSON.parse(readFileSync(BUILD_INFO, 'utf8')) : null;

  /** @type {string[]} */
  const problems = [];
  if (!recorded) {
    problems.push('vendor/audiobox/build-info.json is missing — run `npm run build:wasm`');
  } else {
    if (recorded.artifact?.sha256 !== artifact.sha256) {
      problems.push(
        `vendor/audiobox/mp3-encoder.wasm hashes to ${artifact.sha256}, but build-info.json records ${recorded.artifact?.sha256}`,
      );
    }
    if (recorded.sources?.sha256 !== sources.sha256) {
      problems.push(
        `the encoder sources changed (${sources.files} files, ${sources.sha256}) since the .wasm was built — run \`npm run build:wasm\``,
      );
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `✓ vendor/audiobox/mp3-encoder.wasm is current (${artifact.bytes} bytes, sha256 ${artifact.sha256})`,
    );
  }
} else {
  build();
  mkdirSync(dirname(INSTALLED), { recursive: true });
  copyFileSync(BUILT, INSTALLED);

  // Inspect the installed copy, not the build directory: the digest recorded in
  // build-info.json has to describe the file that ships.
  const artifact = await inspect(INSTALLED);
  const sources = hashSources();

  const info = {
    $comment:
      'Generated by tools/build-mp3-wasm.mjs. `npm run check:wasm` verifies it; do not edit it by hand.',
    artifact: { path: 'vendor/audiobox/mp3-encoder.wasm', ...artifact },
    sources,
    toolchain: {
      cargo: version('cargo'),
      rustc: version('rustc'),
      target: TARGET,
    },
    command: `cargo build --release --target ${TARGET} --manifest-path ${CRATE}`,
  };
  writeFileSync(BUILD_INFO, `${JSON.stringify(info, null, 2)}\n`);

  console.log(`✓ vendor/audiobox/mp3-encoder.wasm — ${artifact.bytes} bytes`);
  console.log(`  sha256  ${artifact.sha256}`);
  console.log(`  sources ${sources.files} files, sha256 ${sources.sha256}`);
}
