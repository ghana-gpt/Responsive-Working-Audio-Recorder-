#!/usr/bin/env node
/**
 * Zero-dependency static file server for local development and the e2e test.
 *
 * It mirrors the headers GitHub Pages sends closely enough for the app to
 * behave the same way: correct MIME types (a wrong `text/html` on a module
 * breaks ES imports), `application/manifest+json` for the web manifest and
 * `no-store` so a reload always picks up your edits.
 *
 * Usage:
 *   node tools/dev-server.mjs [--port 4173] [--host 127.0.0.1] [--root .]
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const DEFAULT_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/**
 * Resolve a URL path to a file inside `root`, or null when it escapes the root.
 *
 * @param {string} root
 * @param {string} pathname
 * @returns {string|null}
 */
function resolvePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const target = resolve(root, relative || '.');
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  return target;
}

/**
 * Whether a missing path may be answered with the app shell.
 *
 * Only navigations get the fallback: extension-less paths (deep links such as
 * `/library`) and `.html` documents. A request for a missing asset keeps its
 * 404 so a typo in a module or stylesheet URL fails loudly instead of quietly
 * returning HTML — which is also what GitHub Pages does.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function wantsAppShell(pathname) {
  const extension = extname(pathname).toLowerCase();
  return extension === '' || extension === '.html';
}

/** Send a small plain-text response. */
function sendText(response, status, body) {
  response.writeHead(status, {
    ...DEFAULT_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Stream a file with a MIME type derived from its extension. */
function sendFile(request, response, filePath) {
  const stats = statSync(filePath);
  const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    ...DEFAULT_HEADERS,
    'Content-Type': type,
    'Content-Length': stats.size,
    'Last-Modified': stats.mtime.toUTCString(),
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

/**
 * @param {{ root?: string }} [options]
 * @returns {import('node:http').Server}
 */
export function createStaticServer({ root = PROJECT_ROOT } = {}) {
  const base = resolve(root);

  return createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...DEFAULT_HEADERS, Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    let filePath = resolvePath(base, url.pathname);

    if (!filePath) {
      sendText(response, 403, 'Forbidden');
      return;
    }

    try {
      if (statSync(filePath).isDirectory()) {
        filePath = join(filePath, 'index.html');
        statSync(filePath);
      }
      sendFile(request, response, filePath);
    } catch {
      if (!wantsAppShell(url.pathname)) {
        sendText(response, 404, 'Not found');
        return;
      }
      // Fall back to the app shell so deep links such as `/library` work.
      try {
        const shell = join(base, 'index.html');
        statSync(shell);
        sendFile(request, response, shell);
      } catch {
        sendText(response, 404, 'Not found');
      }
    }
  });
}

/**
 * Start the server and resolve once it is listening.
 *
 * @param {{ root?: string, port?: number, host?: string }} [options]
 * @returns {Promise<{ server: import('node:http').Server, origin: string, port: number, close: () => Promise<void> }>}
 */
export function startServer({ root = PROJECT_ROOT, port = 0, host = '127.0.0.1' } = {}) {
  const server = createStaticServer({ root });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolvePromise({
        server,
        port: actualPort,
        origin: `http://${host}:${actualPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Parse `--flag value` pairs from argv. */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (flag === 'port') options.port = Number(value);
    if (flag === 'host') options.host = value;
    if (flag === 'root') options.root = value;
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(process.env.PORT ?? args.port ?? 4173);
  const host = process.env.HOST ?? args.host ?? '127.0.0.1';

  startServer({ root: args.root ?? PROJECT_ROOT, port, host }).then(({ origin }) => {
    console.log(`Audio Recorder dev server → ${origin}`);
    console.log('Microphone access requires localhost or https. Press Ctrl+C to stop.');
  });
}
