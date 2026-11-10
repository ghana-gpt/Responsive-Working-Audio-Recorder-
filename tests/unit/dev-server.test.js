import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { startServer } from '../../tools/dev-server.mjs';

/**
 * Start the shared server for the whole suite. The port is ephemeral so the
 * tests never clash with a dev server you already have running.
 */
const server = await startServer({ port: 0 });

after(() => server.close());

/**
 * Issue a request with `fetch`, which is what browsers and the e2e suite use.
 *
 * @param {string} path
 * @param {{ method?: string }} [options]
 */
function get(path, options = {}) {
  return fetch(`${server.origin}${path}`, { redirect: 'manual', ...options });
}

/**
 * Send a raw request line so the path reaches the server unnormalised, which is
 * how a path-traversal attempt would arrive.
 *
 * @param {string} path
 * @returns {Promise<{ status: number, body: string }>}
 */
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the app shell at the root with an HTML content type', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(await response.text(), /<!doctype html>/i);
});

test('serves modules, styles and the manifest with the MIME types ES imports need', async () => {
  const module = await get('/scripts/main.js');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /^text\/javascript/);

  const css = await get('/styles/main.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);

  const manifest = await get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);

  const icon = await get('/icons/icon-192.png');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
});

test('sends no-store so a reload always picks up edits', async () => {
  const response = await get('/scripts/main.js');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('answers HEAD without a body', async () => {
  const response = await get('/scripts/main.js', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.ok(Number(response.headers.get('content-length')) > 0);
});

test('returns 404 for a missing asset instead of the HTML shell', async () => {
  for (const path of ['/scripts/does-not-exist.js', '/styles/nope.css', '/icons/missing.png']) {
    const response = await get(path);
    assert.equal(response.status, 404, `${path} should not fall back to index.html`);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(await response.text(), 'Not found');
  }
});

test('falls back to the shell for extension-less deep links and .html paths', async () => {
  for (const path of ['/library', '/deep/link', '/index.html', '/library/index.html']) {
    const response = await get(path);
    assert.equal(response.status, 200, `${path} should serve the app shell`);
    assert.match(await response.text(), /<!doctype html>/i);
  }
});

test('refuses paths that escape the served root', async () => {
  // Malformed escapes and NUL bytes are rejected before touching the disk.
  assert.equal((await rawGet('/%E0%A4%A')).status, 403);
  assert.equal((await rawGet('/index.html%00.js')).status, 403);

  // Percent-encoded separators survive URL parsing, are decoded and then
  // normalised back inside the root — whatever the status, `/etc/passwd` is
  // never served.
  for (const path of ['/..%2f..%2f..%2fetc%2fpasswd', '/scripts%2f..%2f..%2f..%2fetc%2fpasswd']) {
    const response = await rawGet(path);
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(response.body, /root:/);
  }
});

test('rejects methods other than GET and HEAD', async () => {
  const response = await get('/scripts/main.js', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
