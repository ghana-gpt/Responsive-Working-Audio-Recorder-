#!/usr/bin/env node
/**
 * Dependency-free HTML / PWA sanity checks.
 *
 * Catches the mistakes that only show up at runtime: a missing file, a
 * duplicate id, a broken `aria-labelledby`, an untranslated `data-i18n` key or
 * a service worker precaching an asset that does not exist.
 *
 * Usage: node tools/validate-html.mjs [--quiet]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { messages } from '../scripts/modules/i18n.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** @type {{ level: 'ok'|'warn'|'error', message: string }[]} */
const results = [];
const ok = (message) => results.push({ level: 'ok', message });
const warn = (message) => results.push({ level: 'warn', message });
const fail = (message) => results.push({ level: 'error', message });

/** Read a project file, reporting a failure instead of throwing. */
function read(relativePath) {
  const path = join(ROOT, relativePath);
  if (!existsSync(path)) {
    fail(`missing file: ${relativePath}`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

/** @param {string} html */
function checkDocument(html) {
  if (!/^<!doctype html>/i.test(html.trimStart())) fail('missing <!doctype html>');
  else ok('doctype');

  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  if (!/\blang="[^"]+"/i.test(htmlTag)) fail('<html> has no lang attribute');
  else ok(`html lang=${htmlTag.match(/\blang="([^"]+)"/i)[1]}`);

  if (!/<title>[^<]{3,}<\/title>/i.test(html)) fail('missing or empty <title>');
  else ok('title');

  if (!/<meta\s+charset=/i.test(html)) fail('missing <meta charset>');
  if (!/name="viewport"/i.test(html)) fail('missing viewport meta');
  if (!/http-equiv="Content-Security-Policy"/i.test(html)) warn('no Content-Security-Policy meta');

  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
  const heading = html.match(/<h1\b[^>]*>([^<]+)</i)?.[1]?.trim();
  if (title && heading && title === heading) ok(`title matches h1 (“${title}”)`);
}

/** @param {string} html */
function checkStructure(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let problem = false;

  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(stripped))) {
    const [, closing, rawName, , selfClosing] = match;
    const name = rawName.toLowerCase();
    if (name === '!doctype') continue;

    if (closing) {
      const openIndex = stack.lastIndexOf(name);
      if (openIndex === -1) {
        fail(`unexpected closing tag </${name}>`);
        problem = true;
        continue;
      }
      if (openIndex !== stack.length - 1) {
        fail(`</${name}> closes out of order (open: <${stack[stack.length - 1]}>)`);
        problem = true;
      }
      stack.length = openIndex;
      continue;
    }

    if (selfClosing || VOID_ELEMENTS.has(name)) continue;
    stack.push(name);
  }

  if (stack.length > 0) {
    fail(`unclosed element(s): ${stack.join(', ')}`);
    problem = true;
  }
  if (!problem) ok('tags are balanced');
}

/** @param {string} html */
function checkIds(html) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) fail(`duplicate id(s): ${[...duplicates].join(', ')}`);
  else ok(`${ids.length} unique ids`);

  // Every aria reference and <label for> must point at a real element.
  const references = [];
  for (const match of html.matchAll(/\s(?:aria-labelledby|aria-describedby)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) references.push(id);
  }
  for (const match of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) references.push(match[1]);

  const dangling = [...new Set(references)].filter((id) => id && !seen.has(id));
  if (dangling.length > 0) fail(`dangling references: ${dangling.join(', ')}`);
  else ok(`${references.length} id references resolve`);
}

/** Every local asset referenced by the document must exist. */
function checkAssets(html) {
  const references = new Set();
  for (const match of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) references.add(match[1]);

  const missing = [];
  for (const reference of references) {
    if (/^(https?:|mailto:|tel:|data:|blob:|#)/.test(reference)) continue;
    const path = reference.split(/[?#]/)[0];
    if (!path) continue;
    if (!existsSync(join(ROOT, path))) missing.push(path);
  }
  if (missing.length > 0) fail(`missing local asset(s): ${missing.join(', ')}`);
  else ok(`${references.size} asset references resolve`);
}

/** All `data-i18n*` keys must exist in the default locale. */
function checkTranslations(html) {
  const base = messages.en ?? {};
  const keys = new Set();
  for (const match of html.matchAll(/\sdata-i18n(?:-[a-z]+)?="([^"]+)"/g)) keys.add(match[1]);

  const missing = [...keys].filter((key) => !(key in base));
  if (missing.length > 0) fail(`unknown i18n key(s): ${missing.join(', ')}`);
  else ok(`${keys.size} data-i18n keys resolve`);
}

/** The web manifest must parse and only reference files that exist. */
function checkManifest() {
  const raw = read('manifest.webmanifest');
  if (!raw) return;

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail(`manifest.webmanifest is not valid JSON: ${error.message}`);
    return;
  }
  ok('manifest parses');

  for (const field of ['name', 'short_name', 'start_url', 'display', 'theme_color']) {
    if (!manifest[field]) fail(`manifest is missing "${field}"`);
  }

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  if (icons.length === 0) fail('manifest has no icons');
  const missingIcons = icons
    .map((icon) => icon.src)
    .filter((src) => !src || !existsSync(join(ROOT, src)));
  if (missingIcons.length > 0) fail(`manifest icon(s) missing: ${missingIcons.join(', ')}`);
  else if (icons.length > 0) ok(`${icons.length} manifest icons exist`);

  const sizes = icons.map((icon) => icon.sizes);
  if (!sizes.includes('192x192') || !sizes.includes('512x512')) {
    warn('manifest should ship 192x192 and 512x512 icons for installability');
  }
  if (!icons.some((icon) => icon.purpose === 'maskable')) {
    warn('no maskable icon: Android may crop the artwork');
  }
}

/** The service worker must not precache files that do not exist. */
function checkServiceWorker() {
  const source = read('service-worker.js');
  if (!source) return;

  const listed = [...source.matchAll(/'\.\/([^']*)'/g)]
    .map((match) => match[1])
    .filter((path) => path && /\.[a-z0-9]+$/i.test(path));

  const missing = [...new Set(listed)].filter((path) => !existsSync(join(ROOT, path)));
  if (missing.length > 0) fail(`service worker precaches missing file(s): ${missing.join(', ')}`);
  else ok(`${new Set(listed).size} precached assets exist`);

  // Every module on disk must be precached so an offline boot never misses one.
  const moduleDir = join(ROOT, 'scripts/modules');
  if (existsSync(moduleDir)) {
    const onDisk = readdirSync(moduleDir).filter((name) => name.endsWith('.js'));
    const notPrecached = onDisk.filter((name) => !listed.includes(`scripts/modules/${name}`));
    if (notPrecached.length > 0) warn(`module not precached: ${notPrecached.join(', ')}`);
    else ok(`${onDisk.length} modules precached`);
  }
}

const html = read('index.html');
if (html) {
  checkDocument(html);
  checkStructure(html);
  checkIds(html);
  checkAssets(html);
  checkTranslations(html);
}
checkManifest();
checkServiceWorker();

const errors = results.filter((result) => result.level === 'error');
const warnings = results.filter((result) => result.level === 'warn');

if (!QUIET) {
  for (const result of results) {
    if (result.level === 'ok' && errors.length > 0) continue;
    const icon = result.level === 'ok' ? '✔' : result.level === 'warn' ? '▲' : '✖';
    console.log(`${icon} ${result.message}`);
  }
}

console.log(
  `\n${results.filter((r) => r.level === 'ok').length} checks passed · ${warnings.length} warning(s) · ${errors.length} error(s)`,
);

process.exitCode = errors.length > 0 ? 1 : 0;
