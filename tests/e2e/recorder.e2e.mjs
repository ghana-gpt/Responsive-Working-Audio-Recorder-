#!/usr/bin/env node
/**
 * End-to-end smoke test for the recorder.
 *
 * Boots the real app in Chromium with a fake microphone, then drives the flow a
 * user would: record → pause → resume → stop, reload to prove IndexedDB
 * persistence, rename, play, delete, switch language/theme and check the
 * service worker registers. Screenshots of failures are written to
 * `tests/e2e/.artifacts/`.
 *
 * Usage:
 *   npm run test:e2e
 *   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
 *
 * When no Chromium/Chrome binary is found the script exits 0 (skipped) unless
 * `E2E_STRICT=1` is set, which turns the skip into a failure — used by CI.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { LIBRARY_PAGE_SIZE } from '../../scripts/modules/library.js';
import { encodeWav } from '../../scripts/modules/wav.js';
import { createZip } from '../../scripts/modules/zip.js';
import { startServer } from '../../tools/dev-server.mjs';

const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), '.artifacts');
const STRICT = process.env.E2E_STRICT === '1';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** Locate a Chromium-based browser, preferring explicit env overrides. */
function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const resolved = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--mute-audio',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

/** @type {{ name: string, ok: boolean, ms: number }[]} */
const results = [];

async function step(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started });
    console.error(`  ✖ ${name}`);
    throw error;
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    const message =
      'No Chromium/Chrome binary found. Set PUPPETEER_EXECUTABLE_PATH to run the e2e test.';
    if (STRICT) {
      console.error(`✖ ${message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`▲ ${message} Skipping.`);
    return;
  }

  console.log(`Browser: ${executablePath}`);
  mkdirSync(ARTIFACTS, { recursive: true });

  const { origin, close: closeServer } = await startServer({ port: 0 });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: CHROME_ARGS,
    });
  } catch (error) {
    console.error(`✖ Could not launch ${executablePath}: ${error.message}`);
    console.error('  Hint: set PUPPETEER_EXECUTABLE_PATH to a working Chrome/Chromium binary.');
    await closeServer();
    process.exitCode = 1;
    return;
  }

  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    const context = browser.defaultBrowserContext();
    await context.overridePermissions(origin, ['microphone']);

    const rowCount = () => page.$$eval('#recording-list .recording', (rows) => rows.length);
    const textOf = (selector) =>
      page.$eval(selector, (element) => (element.textContent ?? '').trim());
    const mode = () => page.$eval('#recorder-panel', (panel) => panel.dataset.mode);
    const waitForMode = (expected) =>
      page.waitForFunction(
        (value) => document.querySelector('#recorder-panel')?.dataset.mode === value,
        { timeout: 20000 },
        expected,
      );
    const waitForRows = (count) =>
      page.waitForFunction(
        (expected) => document.querySelectorAll('#recording-list .recording').length === expected,
        { timeout: 20000 },
        count,
      );

    await step('loads without JavaScript errors', async () => {
      await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#record-btn', { visible: true });
      await page.waitForFunction(() => document.querySelector('#record-btn')?.disabled === false, {
        timeout: 15000,
      });
      assert.equal(await mode(), 'idle');
      assert.deepEqual(pageErrors, []);
    });

    await step('renders the accessible recorder controls', async () => {
      const label = await page.$eval('#record-btn', (button) => button.getAttribute('aria-label'));
      assert.equal(label, 'Start recording');
      assert.equal(await textOf('#timer'), '00:00');
      assert.equal(
        await page.$eval('#level-meter', (meter) => meter.getAttribute('role')),
        'meter',
      );
      const formats = await page.$$eval('#format-options input[name="format"]', (inputs) =>
        inputs.map((input) => input.value),
      );
      assert.ok(formats.includes('auto'), 'the automatic format is offered');
      assert.ok(formats.length >= 4, 'every format preference is listed');
    });

    await step('records, pauses, resumes and saves audio', async () => {
      await page.click('#record-btn');
      await waitForMode('recording');
      await pause(900);
      await page.click('#pause-btn');
      await waitForMode('paused');
      await pause(250);
      await page.click('#pause-btn');
      await waitForMode('recording');
      await pause(500);
      await page.click('#stop-btn');
      await waitForMode('ready');
      await waitForRows(1);
      assert.equal(await textOf('#library-count'), '1 saved');
      const meta = await textOf('#recording-list .recording__meta');
      assert.match(meta, /\d/, 'row shows size and duration metadata');
    });

    await step('keeps the recording after a reload (IndexedDB)', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForRows(1);
      assert.equal(await rowCount(), 1);
    });

    await step('renames a recording with tags', async () => {
      await page.click('#recording-list .recording [data-action="rename"]');
      await page.waitForSelector('.recording__rename input[name="name"]');
      await page.type('.recording__rename input[name="name"]', 'Team standup');
      await page.type('.recording__rename input[name="tags"]', 'work, notes');
      await page.click('.recording__rename button[type="submit"]');
      await page.waitForFunction(
        () =>
          document.querySelector('#recording-list .recording__name')?.textContent.trim() ===
          'Team standup',
        { timeout: 10000 },
      );
      const tags = await page.$$eval('#recording-list .tag', (nodes) =>
        nodes.map((node) => node.textContent.trim()),
      );
      assert.deepEqual(tags, ['work', 'notes']);
    });

    await step('plays the recording in the preview player', async () => {
      await page.click('#recording-list .recording [data-action="play"]');
      await page.waitForFunction(
        () =>
          document.querySelector('#recording-list .recording')?.dataset.active === 'true' &&
          document.querySelector('#preview-audio')?.hidden === false,
        { timeout: 15000 },
      );
      const playing = await page.$eval('#preview-audio', (audio) => !audio.paused);
      assert.equal(playing, true, 'the preview player is playing');
    });

    await step('shows sub-second trim readouts and cancels safely', async () => {
      await page.click('#recording-list .recording [data-action="trim"]');
      await page.waitForSelector('#trim-dialog[open]', { timeout: 10000 });
      const end = await textOf('#trim-end-value');
      assert.match(end, /^\d+\.\d s$/, `the end readout "${end}" keeps a decimal`);
      // The trim handles are percentages of the clip, not seconds.
      await page.$eval('#trim-end', (input) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '50');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const half = await textOf('#trim-end-value');
      assert.match(half, /^\d+\.\d s$/, `the 50% readout "${half}" keeps a decimal`);
      assert.notEqual(half, end, 'the readout tracks the handle');
      await page.click('#trim-cancel');
      await page.waitForFunction(() => document.querySelector('#trim-dialog')?.open === false);
      assert.equal(await rowCount(), 1, 'cancelling keeps the library untouched');
    });

    await step('downloads a recording and reports it with a toast', async () => {
      await page.click('#recording-list .recording [data-action="download"]');
      await page.waitForSelector('#toast-host .toast--success', { timeout: 10000 });
      assert.ok((await rowCount()) === 1, 'downloading does not remove the row');
    });

    await step('deletes a recording after confirmation', async () => {
      await page.click('#recording-list .recording [data-action="delete"]');
      await page.waitForSelector('#confirm-dialog[open]', { timeout: 10000 });
      await page.click('#confirm-accept');
      await waitForRows(0);
      const empty = await textOf('#library-empty');
      assert.match(empty, /Nothing recorded yet|No recordings match/);
    });

    await step('pages a long library and bulk deletes the selection', async () => {
      // Real WAV fixtures imported through the file picker: no seeding shortcuts.
      // They live under the repo because snap-confined Chromium cannot read /tmp.
      const folder = mkdtempSync(join(ARTIFACTS, 'fixtures-'));
      const paths = [];
      const samples = new Float32Array(400).fill(0.25); // 50 ms at 8 kHz
      for (let index = 0; index < LIBRARY_PAGE_SIZE + 10; index += 1) {
        const file = join(folder, `Bulk ${String(index + 1).padStart(2, '0')}.wav`);
        writeFileSync(file, Buffer.from(encodeWav([samples], 8000)));
        paths.push(file);
      }

      try {
        const input = await page.$('#import-input');
        assert.ok(input, 'the import input exists');
        await input.uploadFile(...paths);
        await waitForRows(LIBRARY_PAGE_SIZE);
        assert.equal(
          await textOf('#library-count'),
          `${LIBRARY_PAGE_SIZE + 10} saved`,
          'every imported file is stored',
        );
        assert.match(
          await textOf('#library-more-btn'),
          /Show 10 more/,
          'the first page stops at the page size',
        );

        await page.click('#library-more-btn');
        await waitForRows(LIBRARY_PAGE_SIZE + 10);
        assert.equal(
          await page.$eval('#library-more', (element) => element.hasAttribute('hidden')),
          true,
          'the button hides once the whole library is rendered',
        );

        await page.click('#select-all');
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll('#recording-list [data-action="select"]:checked').length ===
            count,
          { timeout: 10000 },
          LIBRARY_PAGE_SIZE + 10,
        );
        assert.match(await textOf('#selection-count'), /selected/i);

        await page.click('#delete-selected-btn');
        await page.waitForSelector('#confirm-dialog[open]', { timeout: 10000 });
        await page.click('#confirm-accept');
        await waitForRows(0);
        assert.equal(
          await page.$eval('#library-count', (element) => element.textContent.trim()),
          '',
          'the counter clears with the library',
        );
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    await step('restores recordings from a ZIP backup', async () => {
      // The archive is built by the same writer the "Download all as ZIP" flow uses.
      const folder = mkdtempSync(join(ARTIFACTS, 'restore-'));
      const samples = new Float32Array(400).fill(0.25); // 50 ms at 8 kHz
      const wav = new Uint8Array(encodeWav([samples], 8000));
      const zipPath = join(folder, 'backup.zip');
      writeFileSync(
        zipPath,
        Buffer.from(
          createZip([
            { name: 'Restored 01.wav', data: wav },
            { name: 'Restored 02.wav', data: wav },
          ]),
        ),
      );

      try {
        const input = await page.$('#import-input');
        assert.ok(input, 'the import input exists');
        await input.uploadFile(zipPath);
        await waitForRows(2);
        assert.equal(await textOf('#library-count'), '2 saved', 'every entry is restored');
        assert.deepEqual(
          await page.$$eval('#recording-list .recording__name', (nodes) =>
            nodes.map((node) => node.textContent.trim()).sort(),
          ),
          ['Restored 01', 'Restored 02'],
          'entry file names become recording names',
        );
        assert.match(await textOf('#toast-host'), /Restored 2 recording/i);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    await step('rejects a damaged archive without touching the library', async () => {
      const folder = mkdtempSync(join(ARTIFACTS, 'damaged-'));
      const zipPath = join(folder, 'broken.zip');
      writeFileSync(zipPath, Buffer.from('this is definitely not a ZIP archive'));

      try {
        const input = await page.$('#import-input');
        await input.uploadFile(zipPath);
        await page.waitForSelector('#toast-host .toast--error', { timeout: 10000 });
        assert.match(await textOf('#toast-host'), /could not be read/i);
        assert.equal(await rowCount(), 2, 'the restored recordings are still there');
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    await step('switches language and translates the interface', async () => {
      await page.select('#locale-select', 'fr');
      await page.waitForFunction(() => document.documentElement.lang === 'fr', { timeout: 10000 });
      const label = await page.$eval('#record-btn', (button) => button.getAttribute('aria-label'));
      assert.notEqual(label, 'Start recording');
      assert.match(label ?? '', /Démarrer|Enregistrer/i);
      await page.select('#locale-select', 'en');
      await page.waitForFunction(() => document.documentElement.lang === 'en', { timeout: 10000 });
    });

    await step('applies and persists the dark theme', async () => {
      await page.select('#theme-select', 'dark');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', {
        timeout: 10000,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', {
        timeout: 10000,
      });
    });

    await step('ignores shortcuts while typing but opens help with “?”', async () => {
      await page.click('#search-input');
      await page.type('#search-input', 'r');
      assert.notEqual(await mode(), 'recording', 'typing “r” must not start a recording');
      await page.$eval('#search-input', (input) => input.blur());
      await page.click('#main', { offset: { x: 5, y: 5 } });
      await page.keyboard.press('?');
      await page.waitForFunction(
        () => document.querySelector('#help-panel')?.hasAttribute('open') === true,
        { timeout: 10000 },
      );
    });

    await step('registers the service worker and exposes the manifest', async () => {
      const manifestHref = await page.$eval('link[rel="manifest"]', (link) => link.href);
      assert.match(manifestHref, /manifest\.webmanifest$/);

      const state = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 'unsupported';
        const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000));
        const ready = navigator.serviceWorker.ready.then(
          (registration) => registration.active?.state ?? 'none',
        );
        return Promise.race([ready, timeout]);
      });
      assert.ok(
        ['activated', 'activating', 'unsupported'].includes(state),
        `service worker state: ${state}`,
      );
    });

    assert.deepEqual(pageErrors, [], 'the page logged no errors');
  } catch (error) {
    if (page) {
      try {
        await page.screenshot({ path: join(ARTIFACTS, 'failure.png'), fullPage: true });
        console.error(`  screenshot: ${join(ARTIFACTS, 'failure.png')}`);
      } catch {
        /* the page may be gone */
      }
    }
    console.error(`\n${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await closeServer();
  }
}

await main();

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} e2e steps passed`);
if (process.exitCode === undefined && results.some((result) => !result.ok)) process.exitCode = 1;
