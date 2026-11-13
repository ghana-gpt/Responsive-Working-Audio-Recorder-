#!/usr/bin/env node
/**
 * End-to-end test for the local transcription flow.
 *
 * The Whisper worker is replaced by a stub (installed with
 * `evaluateOnNewDocument`) so the test exercises everything around it — decoding
 * the stored audio, the progress readout, persistence in IndexedDB, search,
 * editing, SubRip/TXT export, the clipboard and the opt-in live captions —
 * without downloading or running the 45 MB model.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { ASR_MODEL_LABEL } from '../../scripts/modules/asr.js';
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

/** Wait until the download folder contains a file matching `pattern`. */
async function waitForDownload(folder, pattern, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const name = readdirSync(folder).find((file) => pattern.test(file));
    if (name) return join(folder, name);
    await pause(100);
  }
  throw new Error(`no ${pattern} download in ${folder}`);
}

/**
 * Replace the real module worker with a deterministic stub.
 *
 * It speaks the same protocol as `scripts/modules/asr-worker.js`: one
 * `transcribe` request in, `progress` messages, then a `result` whose text
 * encodes the clip length. `window.__asrDelayMs` throttles the answer so the
 * test can observe the busy state, and `window.__asrPosts` records what the
 * client sent.
 */
const installStubWorker = () => {
  window.__asrPosts = [];
  window.__asrDelayMs = 600;

  class StubWorker {
    constructor() {
      this.listeners = new Map();
      this.cancelled = new Set();
      setTimeout(() => this.emit({ type: 'progress', stage: 'load', fraction: null }), 40);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    }

    terminate() {}

    emit(data) {
      for (const handler of this.listeners.get('message') ?? []) handler({ data });
    }

    postMessage(message) {
      window.__asrPosts.push({ type: message.type, id: message.id });
      if (message.type === 'cancel') {
        this.cancelled.add(message.id);
        return;
      }
      if (message.type !== 'transcribe') return;

      const { id, samples, sampleRate, language } = message;
      const seconds = (samples?.length ?? 0) / (Number(sampleRate) || 16000);
      const delay = Number(window.__asrDelayMs) || 0;
      setTimeout(
        () => this.emit({ type: 'progress', id, stage: 'decode', fraction: 0.5 }),
        Math.round(delay / 2),
      );
      setTimeout(() => {
        if (this.cancelled.has(id)) return;
        this.emit({
          type: 'result',
          id,
          text: `stub transcript of ${seconds.toFixed(1)} seconds`,
          segments: [{ start: 0, end: 1.5, text: 'stub transcript' }],
          language: language === 'auto' ? 'en' : language,
          skippedWindows: 0,
          durationSeconds: seconds,
        });
      }, delay);
    }
  }

  window.Worker = StubWorker;
};

/** Capture clipboard writes so the copy action can be asserted headlessly. */
const installClipboardStub = () => {
  window.__clipboard = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        window.__clipboard = String(text);
      },
      readText: async () => window.__clipboard,
    },
  });
};

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
  // Snap-confined Chromium cannot write to /tmp, so downloads stay inside the repo.
  const downloadDir = mkdtempSync(join(ARTIFACTS, 'downloads-'));

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
    rmSync(downloadDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  let page;
  const client = await browser.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(installStubWorker);
    await page.evaluateOnNewDocument(installClipboardStub);

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
    /** Wait until a selector's text contains `fragment`. */
    const waitForText = (selector, fragment, timeout = 20000) =>
      page.waitForFunction(
        (target, expected) => {
          const node = document.querySelector(target);
          return (node?.textContent ?? '').includes(expected);
        },
        { timeout },
        selector,
        fragment,
      );
    const search = async (value) => {
      await page.$eval(
        '#search-input',
        (input, next) => {
          input.value = next;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        value,
      );
    };

    await step('loads the recorder without errors', async () => {
      await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#record-btn')?.disabled === false, {
        timeout: 20000,
      });
      assert.deepEqual(pageErrors, []);
    });

    await step('advertises the transcription settings', async () => {
      const languages = await page.$$eval('#asr-language option', (options) =>
        options.map((option) => option.value),
      );
      assert.ok(languages.includes('auto'), 'auto-detect is offered');
      assert.ok(languages.length > 2, 'more than one language can be picked');
      const hint = await textOf('#asr-model-hint');
      assert.ok(hint.includes(ASR_MODEL_LABEL), `the hint names the model: ${hint}`);
      assert.match(hint, /\d/, 'the hint states the download size');
      const live = await page.$eval('#live-transcribe', (input) => input.checked);
      assert.equal(live, false, 'live captions stay opt-in');
    });

    await step('records a clip to transcribe', async () => {
      await page.click('#record-btn');
      await waitForMode('recording');
      await pause(1_400);
      await page.click('#stop-btn');
      await waitForMode('ready');
      await waitForRows(1);
    });

    await step('shows progress before storing the transcript', async () => {
      await page.click('#recording-list .recording [data-action="transcribe"]');
      await page.waitForSelector('#recording-list .transcript--busy [data-progress]', {
        timeout: 15000,
      });
      const status = await textOf('#recording-list .transcript__status');
      assert.ok(status.length > 0, 'the busy panel explains what is happening');
      await page.waitForSelector('#recording-list [data-action="cancel-transcribe"]', {
        timeout: 5000,
      });
      await page.waitForSelector('#recording-list .transcript__text', { timeout: 25000 });
      const text = await textOf('#recording-list .transcript__text');
      assert.match(text, /^stub transcript of \d+\.\d seconds$/);
      const meta = await textOf('#recording-list .transcript__meta');
      assert.ok(meta.includes(ASR_MODEL_LABEL), `the meta line names the model: ${meta}`);
      const srtDisabled = await page.$eval(
        '#recording-list [data-action="download-transcript-srt"]',
        (button) => button.disabled,
      );
      assert.equal(srtDisabled, false, 'SubRip is offered while timings exist');
      await page.waitForSelector('#toast-host .toast--success', { timeout: 10000 });
    });

    await step('keeps the transcript across a reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForRows(1);
      await page.waitForSelector('#recording-list .transcript__text', { timeout: 20000 });
      const text = await textOf('#recording-list .transcript__text');
      assert.match(text, /^stub transcript of \d+\.\d seconds$/);
    });

    await step('finds the recording by its transcript', async () => {
      await search('stub transcript');
      await waitForRows(1);
      await search('no-such-words-anywhere');
      await page.waitForFunction(
        () => document.querySelectorAll('#recording-list .recording').length === 0,
        { timeout: 15000 },
      );
      assert.ok((await textOf('#library-empty')).length > 0, 'the empty state explains why');
      await search('');
      await waitForRows(1);
    });

    await step('downloads SubRip subtitles', async () => {
      await page.click('#recording-list [data-action="download-transcript-srt"]');
      const file = await waitForDownload(downloadDir, /\.srt$/);
      assert.equal(
        readFileSync(file, 'utf8'),
        '1\n00:00:00,000 --> 00:00:01,500\nstub transcript\n',
      );
    });

    await step('edits the transcript and drops stale timings', async () => {
      await page.click('#recording-list [data-action="edit-transcript"]');
      await page.waitForSelector('#recording-list .transcript__editor', { timeout: 10000 });
      await page.$eval('#recording-list .transcript__editor', (textarea) => {
        textarea.focus();
        textarea.select();
      });
      await page.keyboard.type('edited by the user');
      await page.click('#recording-list .transcript__form button[type="submit"]');
      await waitForText('#recording-list .transcript__text', 'edited by the user', 15000);
      const srtDisabled = await page.$eval(
        '#recording-list [data-action="download-transcript-srt"]',
        (button) => button.disabled,
      );
      assert.equal(srtDisabled, true, 'bare text has no timings to export');
      const hint = await textOf('#recording-list .transcript__hint');
      assert.ok(hint.length > 0, 'the UI explains why SubRip is gone');
    });

    await step('copies and downloads the edited text', async () => {
      await page.click('#recording-list [data-action="copy-transcript"]');
      await page.waitForFunction(() => window.__clipboard === 'edited by the user', {
        timeout: 10000,
      });
      await page.click('#recording-list [data-action="download-transcript-txt"]');
      const file = await waitForDownload(downloadDir, /\.txt$/);
      assert.equal(readFileSync(file, 'utf8'), 'edited by the user');
    });

    await step('keeps the edit across a reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForRows(1);
      await waitForText('#recording-list .transcript__text', 'edited by the user', 20000);
      const srtDisabled = await page.$eval(
        '#recording-list [data-action="download-transcript-srt"]',
        (button) => button.disabled,
      );
      assert.equal(srtDisabled, true, 'the edit survived the reload');
    });

    await step('deletes the transcript but keeps the audio', async () => {
      await page.click('#recording-list [data-action="delete-transcript"]');
      await page.waitForSelector('#confirm-dialog[open]', { timeout: 10000 });
      await page.click('#confirm-accept');
      await page.waitForFunction(
        () => document.querySelector('#recording-list .transcript') === null,
        { timeout: 10000 },
      );
      assert.equal(await rowCount(), 1, 'the recording itself is untouched');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForRows(1);
      assert.equal(await page.$('#recording-list .transcript'), null);
    });

    await step('captions a recording live', async () => {
      await page.$eval('#live-transcribe', (input) => {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.click('#record-btn');
      await waitForMode('recording');
      await page.waitForFunction(
        () => {
          const caption = document.querySelector('#live-caption');
          const text = document.querySelector('#live-caption-text')?.textContent.trim() ?? '';
          return caption?.hidden === false && text.length > 0;
        },
        { timeout: 40000 },
      );
      assert.match(await textOf('#live-caption-text'), /^stub transcript of/);

      await page.click('#stop-btn');
      await page.waitForFunction(() => document.querySelector('#live-caption')?.hidden === true, {
        timeout: 20000,
      });
      await waitForMode('ready');
      await waitForRows(2);
      // Preview text is never written to the library on its own.
      assert.equal(await page.$$eval('#recording-list .transcript__text', (n) => n.length), 0);
    });

    await step('finishes without page errors', async () => {
      assert.deepEqual(pageErrors, [], 'no uncaught errors or console errors');
    });

    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} steps passed.`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    if (page) {
      for (const [index, result] of results.entries()) {
        if (!result.ok) {
          await page
            .screenshot({ path: join(ARTIFACTS, `asr-failure-${index}.png`) })
            .catch(() => {});
        }
      }
    }
    await browser.close();
    await closeServer();
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
