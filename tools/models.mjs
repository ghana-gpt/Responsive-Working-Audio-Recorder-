#!/usr/bin/env node
/**
 * Whisper model package: download, verify and rebuild.
 *
 * The quantised Whisper tiny model is ~45 MB of ONNX graphs and tokenizer data.
 * It is deliberately **not** committed: a clone stays small and a push does not
 * have to upload the blobs. The exact files live in a versioned GitHub Release
 * asset described by `model-package.json`, and this tool turns that description
 * into a working `models/whisper-tiny/` directory.
 *
 * Commands:
 *   node tools/models.mjs download   # fetch + verify + install (idempotent)
 *   node tools/models.mjs verify     # check installed files against the manifest
 *   node tools/models.mjs package    # rebuild the release archive from models/whisper-tiny
 *
 * The app itself never runs this: `npm run models:download` is a local-clone and
 * deployment step, and the Pages workflow runs the same code so the published
 * site always ships a byte-verified model.
 *
 * Design notes:
 *  - Only Node built-ins. The archive is `ustar` + gzip, so it needs no
 *    dependency and can be inspected with `tar -tzf`.
 *  - Nothing is written into `models/whisper-tiny/` until both the archive
 *    checksum and every extracted file's size + SHA-256 match the manifest.
 *  - Downloads go to a temporary folder and are discarded on any mismatch, so a
 *    truncated or tampered download can never be mistaken for an install.
 *
 * Environment overrides (tests and offline mirrors):
 *   MODELS_MANIFEST      path to the manifest (default: ./model-package.json)
 *   MODEL_PACKAGE_URL    download URL used instead of the manifest's `url`
 */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

/** Repository root (this file lives in `tools/`). */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Manifest that describes the published model asset. */
export const DEFAULT_MANIFEST = join(PROJECT_ROOT, 'model-package.json');

/** Directory the app serves the model from (`models/whisper-tiny/`). */
export const DEFAULT_MODEL_DIR = join(PROJECT_ROOT, 'models', 'whisper-tiny');

/** A failure the CLI can report as a single, actionable sentence. */
export class ModelPackageError extends Error {
  /**
   * @param {string} code stable identifier (`checksumMismatch`, `downloadFailed`, …)
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ModelPackageError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Hashing and the manifest                                                   */
/* -------------------------------------------------------------------------- */

/** @param {Buffer|string} buffer */
export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * SHA-256 of a file, streamed so a 30 MB graph does not have to fit in memory.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(/** @type {Buffer} */ (chunk));
  }
  return hash.digest('hex');
}

/**
 * Parse and sanity-check `model-package.json`.
 *
 * @param {string} [file]
 * @returns {{
 *   name: string,
 *   version: string,
 *   release: string,
 *   archive: string,
 *   url: string,
 *   sha256: string,
 *   bytes: number,
 *   modelBytes: number,
 *   files: Record<string, { bytes: number, sha256: string }>,
 * }}
 */
export function readManifest(file = process.env.MODELS_MANIFEST || DEFAULT_MANIFEST) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ModelPackageError(
      'manifestMissing',
      `No model manifest at ${relative(PROJECT_ROOT, file) || file} (${error.message}).`,
    );
  }

  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ModelPackageError('manifestInvalid', `${file} is not valid JSON: ${error.message}`);
  }

  for (const key of ['name', 'version', 'release', 'archive', 'url', 'sha256']) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      throw new ModelPackageError(
        'manifestInvalid',
        `${file}: "${key}" must be a non-empty string.`,
      );
    }
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new ModelPackageError(
      'manifestInvalid',
      `${file}: "sha256" must be a lowercase hex digest.`,
    );
  }
  if (
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    !Object.keys(manifest.files).length
  ) {
    throw new ModelPackageError('manifestInvalid', `${file}: "files" must list packaged files.`);
  }
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!entry || typeof entry !== 'object') {
      throw new ModelPackageError('manifestInvalid', `${file}: "files.${path}" must be an object.`);
    }
    const { bytes, sha256 } = /** @type {{ bytes?: unknown, sha256?: unknown }} */ (entry);
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new ModelPackageError(
        'manifestInvalid',
        `${file}: "files.${path}.bytes" must be a number.`,
      );
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ModelPackageError(
        'manifestInvalid',
        `${file}: "files.${path}.sha256" must be a lowercase hex digest.`,
      );
    }
  }

  return manifest;
}

/**
 * Check an installed model directory against the manifest.
 *
 * @param {{ manifest: ReturnType<typeof readManifest>, modelDir?: string }} options
 * @returns {Promise<{ ok: string[], missing: string[], mismatched: Array<{ path: string, reason: string }> }>}
 */
export async function verifyTree({ manifest, modelDir = DEFAULT_MODEL_DIR }) {
  /** @type {string[]} */ const ok = [];
  /** @type {string[]} */ const missing = [];
  /** @type {Array<{ path: string, reason: string }>} */ const mismatched = [];

  for (const [path, expected] of Object.entries(manifest.files)) {
    const file = join(modelDir, ...path.split('/'));
    /** @type {import('node:fs').Stats} */
    let stats;
    try {
      stats = statSync(file);
    } catch {
      missing.push(path);
      continue;
    }
    if (!stats.isFile()) {
      mismatched.push({ path, reason: 'not a regular file' });
      continue;
    }
    if (stats.size !== expected.bytes) {
      mismatched.push({ path, reason: `size ${stats.size} B, expected ${expected.bytes} B` });
      continue;
    }
    const digest = await sha256File(file);
    if (digest !== expected.sha256) {
      mismatched.push({ path, reason: `sha256 ${digest}` });
      continue;
    }
    ok.push(path);
  }

  return { ok, missing, mismatched };
}

/**
 * Every file under `modelDir`, relative to it, sorted (`package` and diagnostics).
 *
 * @param {string} [modelDir]
 * @returns {string[]}
 */
export function listModelFiles(modelDir = DEFAULT_MODEL_DIR) {
  if (!existsSync(modelDir)) return [];
  return readdirSync(modelDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(modelDir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}
/* -------------------------------------------------------------------------- */
/* tar + gzip                                                                 */
/* -------------------------------------------------------------------------- */

/** Write `value` into `buffer` as zero-padded octal plus a NUL terminator. */
function writeOctal(buffer, value, offset, length) {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'latin1');
}

/** Read a NUL/space terminated octal field. */
function readOctal(buffer, offset, length) {
  const text = buffer
    .toString('latin1', offset, offset + length)
    .replace(/\0.*$/, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new ModelPackageError('tarInvalid', `bad octal field "${text}" in a tar header`);
  }
  return Number.parseInt(text, 8);
}

/** Read a NUL terminated string field. */
function readString(buffer, offset, length) {
  return buffer.toString('latin1', offset, offset + length).replace(/\0.*$/, '');
}

/**
 * A single 512-byte ustar header for a regular file.
 *
 * mtime, uid and gid are pinned to 0 so re-packing the same bytes produces the
 * same tar on the same platform.
 *
 * @param {{ name: string, size: number, mode?: number }} entry
 */
function tarHeader({ name, size, mode = 0o644 }) {
  if (Buffer.byteLength(name) > 100) {
    throw new ModelPackageError('tarInvalid', `path too long for ustar: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'latin1');
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime
  header.fill(0x20, 148, 156); // checksum field holds spaces while summing
  header.write('0', 156, 1, 'latin1'); // regular file
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeOctal(header, sum, 148, 7); // 6 digits + NUL
  header.write(' ', 155, 1, 'latin1');
  return header;
}

/**
 * Build an uncompressed ustar archive from `{ name, data }` entries.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
export function createTar(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(tarHeader({ name: entry.name, size: entry.data.length }));
    parts.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return Buffer.concat(parts);
}

/**
 * Parse a tar buffer into regular-file entries.
 *
 * Directories and pax headers are skipped; any other entry type is refused rather
 * than silently ignored, and header checksums are verified so corruption fails
 * here instead of surfacing as a mysterious ONNX error in the browser.
 *
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function parseTar(buffer) {
  /** @type {Array<{ name: string, data: Buffer }>} */ const entries = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return entries;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    const expected = readOctal(header, 148, 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    const actual = copy.reduce((total, byte) => total + byte, 0);
    if (expected !== actual) {
      throw new ModelPackageError(
        'tarInvalid',
        `header checksum mismatch for "${fullName || '?'}" (${expected} != ${actual})`,
      );
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new ModelPackageError('tarInvalid', `truncated archive: "${fullName}" needs ${size} B`);
    }

    if (type === '0') {
      if (!fullName) throw new ModelPackageError('tarInvalid', 'archive entry without a name');
      entries.push({ name: fullName, data: buffer.subarray(dataStart, dataEnd) });
    } else if (type !== '5' && type !== 'x' && type !== 'g' && type !== 'L') {
      throw new ModelPackageError('tarInvalid', `unsupported entry type "${type}" (${fullName})`);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  throw new ModelPackageError('tarInvalid', 'archive has no end-of-archive marker');
}

/**
 * Short, project-relative path for logs; absolute paths are shown as-is when the
 * folder lives outside the repository (temporary test folders, CI workspaces).
 */
function displayPath(path) {
  const relativePath = relative(PROJECT_ROOT, path);
  return relativePath.startsWith('..') ? path : relativePath;
}

/* -------------------------------------------------------------------------- */
/* Archive helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Human readable byte count (`3.5 MB`). */
function formatBytes(bytes) {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Bytes the installed tree occupies. Larger than the archive, which is compressed.
 *
 * @param {{ files: Record<string, { bytes: number }> }} manifest
 * @returns {number}
 */
export function installedBytes(manifest) {
  return Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Resolve an archive path inside `root`, refusing anything that escapes it.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
function safeJoin(root, name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new ModelPackageError('tarInvalid', `unsafe archive path "${name}"`);
  }
  const target = resolve(root, ...normalized.split('/'));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ModelPackageError('tarInvalid', `archive path escapes its folder: "${name}"`);
  }
  return target;
}

/**
 * Extract a gzipped ustar archive into `dest`.
 *
 * @param {Buffer} gzipped
 * @param {string} dest
 * @returns {string[]} extracted paths, relative to `dest`
 */
export function extractTarGz(gzipped, dest) {
  /** @type {Buffer} */
  let tar;
  try {
    tar = gunzipSync(gzipped);
  } catch (error) {
    throw new ModelPackageError(
      'archiveInvalid',
      `The archive is not valid gzip data (${/** @type {Error} */ (error).message}).`,
    );
  }
  const entries = parseTar(tar);
  const written = [];
  for (const entry of entries) {
    const target = safeJoin(dest, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written.push(entry.name);
  }
  return written;
}

/**
 * Stream `url` into `dest` while hashing it.
 *
 * @param {{ url: string, dest: string, log?: (...args: string[]) => void }} options
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
export async function downloadArchive({ url, dest, log = () => {} }) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    throw new ModelPackageError(
      'downloadFailed',
      `Could not reach ${url}: ${/** @type {Error} */ (error).message}\n` +
        'Check your network connection (or proxy) and try again.',
    );
  }

  if (!response.ok) {
    const hint =
      response.status === 404
        ? ' The release asset is missing: publish `model-package.json` release tag' +
          ' and upload the archive described there.'
        : '';
    throw new ModelPackageError(
      'downloadFailed',
      `Download failed: HTTP ${response.status} ${response.statusText} for ${url}.${hint}`,
    );
  }
  if (!response.body) {
    throw new ModelPackageError('downloadFailed', `Download failed: empty response from ${url}.`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > 0) log(`  ${formatBytes(total)} to download`);

  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  let received = 0;
  let reported = 0;

  try {
    for await (const chunk of Readable.fromWeb(
      /** @type {import('node:stream/web').ReadableStream} */ (response.body),
    )) {
      const buffer = /** @type {Buffer} */ (chunk);
      hash.update(buffer);
      received += buffer.length;
      if (!out.write(buffer)) await once(out, 'drain');
      if (received - reported >= 8 * 1024 * 1024) {
        reported = received;
        const percent = total > 0 ? ` (${Math.round((received / total) * 100)}%)` : '';
        log(`  … ${formatBytes(received)}${percent}`);
      }
    }
    out.end();
    await once(out, 'finish');
  } catch (error) {
    out.destroy();
    rmSync(dest, { force: true });
    throw new ModelPackageError(
      'downloadFailed',
      `The download from ${url} broke after ${formatBytes(received)}: ` +
        `${/** @type {Error} */ (error).message}. Nothing was installed; try again.`,
    );
  }

  return { bytes: received, sha256: hash.digest('hex') };
}

/* -------------------------------------------------------------------------- */
/* Install, verify, package                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Download the release archive, verify it, and atomically replace `modelDir`.
 *
 * Nothing is written outside `models/` and the temporary folder is removed on
 * every path, including failures.
 *
 * @param {{
 *   manifest?: ReturnType<typeof readManifest>,
 *   modelDir?: string,
 *   force?: boolean,
 *   url?: string,
 *   log?: (...args: string[]) => void,
 * }} [options]
 * @returns {Promise<{ installed: boolean, bytes: number, sha256: string, files: number }>}
 */
export async function installModel(options = {}) {
  const manifest = options.manifest ?? readManifest();
  const modelDir = options.modelDir ?? DEFAULT_MODEL_DIR;
  const log = options.log ?? ((...args) => console.log(...args));
  const url = options.url ?? process.env.MODEL_PACKAGE_URL ?? manifest.url;
  const fileCount = Object.keys(manifest.files).length;

  if (!options.force) {
    const current = await verifyTree({ manifest, modelDir });
    if (current.missing.length === 0 && current.mismatched.length === 0) {
      log(`✔ ${manifest.name} ${manifest.version} is already installed (${fileCount} files)`);
      return { installed: false, bytes: 0, sha256: manifest.sha256, files: fileCount };
    }
    if (current.mismatched.length > 0) {
      log(`! ${current.mismatched.length} installed file(s) do not match the manifest; repairing`);
    }
  }

  const parent = dirname(modelDir);
  const staging = join(parent, '.download');
  const archivePath = join(staging, manifest.archive);

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    log(`↓ ${url}`);
    const { bytes, sha256 } = await downloadArchive({ url, dest: archivePath, log });

    if (sha256 !== manifest.sha256) {
      throw new ModelPackageError(
        'checksumMismatch',
        `Checksum mismatch for ${manifest.archive}:\n` +
          `  expected ${manifest.sha256}\n` +
          `  actual   ${sha256}\n` +
          'The download was discarded. This usually means the asset was replaced, a proxy ' +
          'rewrote it, or the manifest is out of date — do not install it.',
      );
    }
    log(`✔ archive checksum matches (${formatBytes(bytes)})`);

    const extracted = join(staging, 'extract');
    mkdirSync(extracted, { recursive: true });
    const written = extractTarGz(readFileSync(archivePath), extracted);

    const topLevel = new Set(written.map((name) => name.split('/')[0]));
    if (topLevel.size !== 1 || !topLevel.has(manifest.name)) {
      throw new ModelPackageError(
        'archiveInvalid',
        `The archive must contain a single "${manifest.name}/" folder, found: ` +
          `${[...topLevel].join(', ') || '(nothing)'}.`,
      );
    }

    const staged = join(extracted, manifest.name);
    const check = await verifyTree({ manifest, modelDir: staged });
    if (check.missing.length > 0 || check.mismatched.length > 0) {
      const details = [
        ...check.missing.map((path) => `  missing ${path}`),
        ...check.mismatched.map(({ path, reason }) => `  ${path}: ${reason}`),
      ].join('\n');
      throw new ModelPackageError(
        'archiveInvalid',
        `The extracted files do not match the manifest:\n${details}\nNothing was installed.`,
      );
    }

    // Swap the verified tree in; keep the old one until the rename succeeded.
    const previous = `${modelDir}.previous-${process.pid}`;
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(modelDir)) renameSync(modelDir, previous);
    try {
      renameSync(staged, modelDir);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, modelDir);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });

    log(
      `✔ Installed ${manifest.name} ${manifest.version} → ${displayPath(modelDir)}` +
        ` (${fileCount} files, ${formatBytes(installedBytes(manifest))})`,
    );
    return { installed: true, bytes, sha256, files: fileCount };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Verify the installed tree and throw with a readable list when it is wrong.
 *
 * @param {{ manifest?: ReturnType<typeof readManifest>, modelDir?: string, log?: (...args: string[]) => void }} [options]
 * @returns {Promise<{ ok: string[], missing: string[], mismatched: Array<{ path: string, reason: string }> }>}
 */
export async function verifyModel({ manifest, modelDir, log = console.log } = {}) {
  const resolvedManifest = manifest ?? readManifest();
  const dir = modelDir ?? DEFAULT_MODEL_DIR;
  const result = await verifyTree({ manifest: resolvedManifest, modelDir: dir });

  if (result.missing.length > 0 || result.mismatched.length > 0) {
    const details = [
      ...result.missing.map((path) => `  missing    ${path}`),
      ...result.mismatched.map(({ path, reason }) => `  ${path}: ${reason}`),
    ].join('\n');
    throw new ModelPackageError(
      'verifyFailed',
      `${relative(PROJECT_ROOT, dir)} does not match ${resolvedManifest.name} ` +
        `${resolvedManifest.version}:\n${details}\n` +
        'Run `npm run models:download` to (re)install it.',
    );
  }

  log(
    `✔ ${resolvedManifest.name} ${resolvedManifest.version} verified: ${result.ok.length} files, ` +
      `${formatBytes(installedBytes(resolvedManifest))} installed ` +
      `(${formatBytes(resolvedManifest.bytes)} archive) in ${relative(PROJECT_ROOT, dir) || '.'}`,
  );
  return result;
}

/**
 * Rebuild the release archive from a local model tree.
 *
 * @param {{ manifest?: ReturnType<typeof readManifest>, modelDir?: string, outDir?: string }} [options]
 * @returns {Promise<{ path: string, bytes: number, sha256: string, files: string[] }>}
 */
export async function packageModel(options = {}) {
  const manifest = options.manifest ?? readManifest();
  const modelDir = options.modelDir ?? DEFAULT_MODEL_DIR;
  const outDir = options.outDir ?? join(PROJECT_ROOT, 'dist');

  const check = await verifyTree({ manifest, modelDir });
  if (check.missing.length > 0 || check.mismatched.length > 0) {
    throw new ModelPackageError(
      'packageFailed',
      `${relative(PROJECT_ROOT, modelDir)} is incomplete or modified ` +
        `(${check.missing.length} missing, ${check.mismatched.length} mismatched); ` +
        'run `npm run models:download -- --force` first.',
    );
  }

  const entries = check.ok.map((path) => ({
    name: `${manifest.name}/${path}`,
    data: readFileSync(join(modelDir, ...path.split('/'))),
  }));
  const archive = gzipSync(createTar(entries), { level: 9 });

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, manifest.archive);
  writeFileSync(path, archive);

  return { path, bytes: archive.length, sha256: sha256Buffer(archive), files: check.ok };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/** Parse `--flag value` / `--flag=value` pairs. */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    if (inline !== undefined) {
      args[flag] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[flag] = argv[index + 1];
      index += 1;
    } else {
      args[flag] = true;
    }
  }
  return args;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const manifest = readManifest(
    typeof args.manifest === 'string' ? resolve(args.manifest) : undefined,
  );
  const modelDir =
    typeof args['model-dir'] === 'string' ? resolve(args['model-dir']) : DEFAULT_MODEL_DIR;

  if (command === 'download') {
    await installModel({
      manifest,
      modelDir,
      force: args.force === true,
      url: typeof args.url === 'string' ? args.url : undefined,
    });
    return;
  }

  if (command === 'verify') {
    await verifyModel({ manifest, modelDir });
    return;
  }

  if (command === 'package') {
    const result = await packageModel({
      manifest,
      modelDir,
      outDir: typeof args.out === 'string' ? resolve(args.out) : join(PROJECT_ROOT, 'dist'),
    });
    console.log(`✔ ${relative(PROJECT_ROOT, result.path)} (${formatBytes(result.bytes)})`);
    console.log(`  sha256 ${result.sha256}`);
    if (result.sha256 !== manifest.sha256) {
      console.log(
        '  ! This differs from model-package.json. Upload the archive, then update the\n' +
          '    manifest (sha256, bytes and per-file entries) before committing it.',
      );
    }
    return;
  }

  throw new ModelPackageError(
    'usage',
    'Usage: node tools/models.mjs <download|verify|package> [--manifest file] ' +
      '[--model-dir dir] [--out dir] [--url url] [--force]',
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`✖ ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
