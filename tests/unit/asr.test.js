import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASR_MODEL_BYTES,
  ASR_MODEL_LABEL,
  ASR_SAMPLE_RATE,
  ASR_WINDOW_SECONDS,
  MAX_TRANSCRIPT_CHARS,
  buildTranscript,
  createTranscriber,
  downmixToMono,
  formatSrt,
  formatTimestamp,
  formatTranscriptText,
  isAsrSupported,
  isModelAvailable,
  mergeWindows,
  normalizeSegments,
  planWindows,
  resampleLinear,
  windowRms,
} from '../../scripts/modules/asr.js';

/** Downloaded model folder, relative to this test file. */
const MODEL_DIR = '../../models/whisper-tiny';
/** The encoder graph is the largest file and only exists in a complete install. */
const ENCODER_FILE = 'onnx/encoder_model_quantized.onnx';

/** Minimal stand-in for a module worker: records posts, lets a test answer. */
function fakeWorker() {
  const listeners = new Map();
  const worker = {
    messages: [],
    terminated: false,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    postMessage(message) {
      worker.messages.push(message);
      return message;
    },
    terminate() {
      worker.terminated = true;
    },
    emit(data) {
      for (const handler of listeners.get('message') ?? []) handler({ data });
    },
    emitError(message) {
      for (const handler of listeners.get('error') ?? []) handler({ message });
    },
  };
  return worker;
}

test('resampleLinear halves the length when the rate halves', () => {
  const input = Float32Array.from({ length: 100 }, (_, index) => index);
  const output = resampleLinear(input, 32_000, 16_000);
  assert.equal(output.length, 50);
  assert.equal(output[0], 0);
  assert.ok(Math.abs(output[1] - 2) < 1e-6, 'linear interpolation keeps the ramp');
  assert.equal(output[49], 98);
});

test('resampleLinear is a no-op for an equal or invalid rate', () => {
  const input = Float32Array.from([1, 2, 3]);
  assert.equal(resampleLinear(input, 16_000, 16_000), input);
  assert.equal(resampleLinear(input, 0, 16_000), input);
  assert.equal(resampleLinear([], 48_000, 16_000).length, 0);
});

test('downmixToMono averages channels and ignores empty ones', () => {
  const mono = downmixToMono([Float32Array.from([1, 0.5]), Float32Array.from([-1, 0.5])]);
  assert.deepEqual([...mono], [0, 0.5], 'average of the two channels');
  assert.deepEqual([...downmixToMono([Float32Array.from([0.25, -1])])], [0.25, -1]);
  assert.equal(downmixToMono([]).length, 0);
  assert.equal(downmixToMono([new Float32Array(0)]).length, 0);
});

test('windowRms reports the level of a block', () => {
  assert.equal(windowRms(Float32Array.from([0, 0, 0])), 0);
  assert.ok(Math.abs(windowRms(Float32Array.from([0.5, -0.5])) - 0.5) < 1e-6);
  assert.equal(windowRms([]), 0);
  assert.equal(windowRms(undefined), 0);
});

test('planWindows cuts the audio into contiguous, non-overlapping 30 s windows', () => {
  const total = ASR_SAMPLE_RATE * 75;
  const windows = planWindows(total);
  assert.equal(ASR_WINDOW_SECONDS, 30);
  assert.equal(windows.length, 3);
  assert.deepEqual(
    windows.map((window) => [window.startSample, window.endSample]),
    [
      [0, ASR_SAMPLE_RATE * 30],
      [ASR_SAMPLE_RATE * 30, ASR_SAMPLE_RATE * 60],
      [ASR_SAMPLE_RATE * 60, total],
    ],
  );
  assert.deepEqual(
    windows.map((window) => window.startSeconds),
    [0, 30, 60],
  );
  // Every sample belongs to exactly one window.
  const covered = windows.reduce((sum, window) => sum + (window.endSample - window.startSample), 0);
  assert.equal(covered, total);
});

test('planWindows returns nothing for empty or invalid input', () => {
  assert.deepEqual(planWindows(0), []);
  assert.deepEqual(planWindows(-5), []);
  assert.deepEqual(planWindows(100, { sampleRate: 0 }), []);
  assert.deepEqual(planWindows(Number.NaN), []);
});

test('normalizeSegments drops empty text and repairs timings', () => {
  const segments = normalizeSegments([
    { start: 5, end: 4, text: '  second   one ' },
    { start: -1, end: Number.NaN, text: 'first' },
    { start: 9, end: 10, text: '   ' },
    null,
  ]);
  assert.deepEqual(segments, [
    { start: 0, end: 0, text: 'first' },
    { start: 5, end: 5, text: 'second one' },
  ]);
});

test('mergeWindows shifts window timings and concatenates the text', () => {
  const merged = mergeWindows([
    {
      startSeconds: 0,
      text: 'Hello there.',
      segments: [{ start: 0, end: 1.5, text: 'Hello there.' }],
    },
    {
      startSeconds: 30,
      text: '  second part ',
      segments: [{ start: 0.25, end: 2, text: 'second part' }],
    },
    { startSeconds: 60, text: 'no segments' },
    null,
  ]);
  assert.equal(merged.text, 'Hello there. second part no segments');
  assert.deepEqual(merged.segments, [
    { start: 0, end: 1.5, text: 'Hello there.' },
    { start: 30.25, end: 32, text: 'second part' },
  ]);
});

test('mergeWindows tolerates a missing list', () => {
  assert.deepEqual(mergeWindows(), { text: '', segments: [] });
  assert.deepEqual(mergeWindows([]), { text: '', segments: [] });
});

test('formatTimestamp writes SubRip and WebVTT stamps', () => {
  assert.equal(formatTimestamp(0), '00:00:00,000');
  assert.equal(formatTimestamp(61.5), '00:01:01,500');
  assert.equal(formatTimestamp(3661.25), '01:01:01,250');
  assert.equal(formatTimestamp(-3), '00:00:00,000');
  assert.equal(formatTimestamp(2, { separator: '.' }), '00:00:02.000');
});

test('formatSrt numbers the cues and ends with a newline', () => {
  const srt = formatSrt([
    { start: 0, end: 1.5, text: 'First line.' },
    { start: 1.5, end: 3, text: 'Second line.' },
  ]);
  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:01,500\nFirst line.\n\n' +
      '2\n00:00:01,500 --> 00:00:03,000\nSecond line.\n',
  );
  assert.equal(formatSrt([]), '');
  assert.equal(formatSrt(undefined), '');
});

test('formatTranscriptText prefers the stored text and falls back to segments', () => {
  assert.equal(formatTranscriptText({ text: '  stored  text ' }), 'stored  text');
  assert.equal(
    formatTranscriptText({ text: '', segments: [{ start: 0, end: 1, text: 'from segments' }] }),
    'from segments',
  );
  assert.equal(formatTranscriptText(null), '');
});

test('buildTranscript normalises the worker result', () => {
  const transcript = buildTranscript(
    {
      text: '  Hello\nworld  ',
      segments: [{ start: 0, end: 1, text: ' Hello world ' }],
      language: 'en',
      skippedWindows: 2,
    },
    { model: 'test-model', createdAt: 1_700_000_000_000, durationSeconds: 12.5 },
  );
  assert.deepEqual(transcript, {
    text: 'Hello world',
    segments: [{ start: 0, end: 1, text: 'Hello world' }],
    language: 'en',
    model: 'test-model',
    createdAt: 1_700_000_000_000,
    durationSeconds: 12.5,
    skippedWindows: 2,
  });
});

test('buildTranscript returns null when nothing was recognised', () => {
  assert.equal(buildTranscript({ text: '   ' }), null);
  assert.equal(buildTranscript({}), null);
  assert.equal(buildTranscript(), null);
});

test('buildTranscript caps the text and defaults the model label', () => {
  const transcript = buildTranscript({ text: 'a'.repeat(MAX_TRANSCRIPT_CHARS + 50) });
  assert.equal(transcript.text.length, MAX_TRANSCRIPT_CHARS);
  assert.equal(transcript.model, ASR_MODEL_LABEL);
  assert.equal(transcript.language, 'auto');
  assert.equal(transcript.skippedWindows, 0);
});

test('isAsrSupported is false outside a browser', () => {
  assert.equal(isAsrSupported(), false, 'Node has no Worker constructor global');
});

test('createTranscriber resolves the worker result', async () => {
  const worker = fakeWorker();
  const transcriber = createTranscriber({ workerFactory: () => worker });
  const promise = transcriber.transcribe(Float32Array.from([0.1, 0.2]), {
    sampleRate: ASR_SAMPLE_RATE,
    language: 'fr',
  });
  assert.equal(transcriber.isBusy(), true);

  const [message] = worker.messages;
  assert.equal(message.type, 'transcribe');
  assert.equal(message.sampleRate, ASR_SAMPLE_RATE);
  assert.equal(message.language, 'fr');
  assert.equal(message.windowSeconds, ASR_WINDOW_SECONDS);

  worker.emit({
    type: 'result',
    id: message.id,
    text: 'bonjour',
    segments: [{ start: 0, end: 1, text: 'bonjour' }],
    language: 'fr',
    skippedWindows: 0,
    durationSeconds: 1,
  });

  const result = await promise;
  assert.equal(result.text, 'bonjour');
  assert.equal(transcriber.isBusy(), false);
});

test('createTranscriber forwards progress and rejects a second job as busy', async () => {
  const worker = fakeWorker();
  const transcriber = createTranscriber({ workerFactory: () => worker });
  const fractions = [];
  const promise = transcriber.transcribe(Float32Array.from([0.1]), {
    sampleRate: ASR_SAMPLE_RATE,
    onProgress: (progress) => fractions.push([progress.stage, progress.fraction]),
  });
  const { id } = worker.messages[0];

  await assert.rejects(
    transcriber.transcribe(Float32Array.from([0.1]), { sampleRate: ASR_SAMPLE_RATE }),
    (error) => error.code === 'busy',
  );

  worker.emit({ type: 'progress', id, stage: 'load', fraction: null });
  worker.emit({ type: 'progress', id, stage: 'decode', fraction: 0.5 });
  // A message for a stale id must be ignored.
  worker.emit({ type: 'progress', id: id + 99, stage: 'decode', fraction: 0.9 });

  worker.emit({ type: 'result', id, text: 'ok', segments: [], language: 'en' });
  await promise;

  assert.deepEqual(fractions, [
    ['load', null],
    ['transcribe', 0.5],
  ]);
});

test('createTranscriber rejects empty audio without starting the worker', async () => {
  let created = 0;
  const transcriber = createTranscriber({
    workerFactory: () => {
      created += 1;
      return fakeWorker();
    },
  });
  await assert.rejects(
    transcriber.transcribe(new Float32Array(0), { sampleRate: ASR_SAMPLE_RATE }),
    (error) => error.code === 'emptyAudio',
  );
  assert.equal(created, 0);
  assert.equal(transcriber.isBusy(), false);
});

test('createTranscriber aborts a running job and tells the worker', async () => {
  const worker = fakeWorker();
  const transcriber = createTranscriber({ workerFactory: () => worker });
  const controller = new AbortController();
  const promise = transcriber.transcribe(Float32Array.from([0.1]), {
    sampleRate: ASR_SAMPLE_RATE,
    signal: controller.signal,
  });
  const { id } = worker.messages[0];

  controller.abort();
  await assert.rejects(promise, (error) => error.code === 'cancelled');
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', id });
  assert.equal(transcriber.isBusy(), false);
});

test('createTranscriber surfaces worker errors and dispose()', async () => {
  const worker = fakeWorker();
  const transcriber = createTranscriber({ workerFactory: () => worker });
  const crashed = transcriber.transcribe(Float32Array.from([0.1]), {
    sampleRate: ASR_SAMPLE_RATE,
  });
  worker.emitError('wasm failed to load');
  await assert.rejects(crashed, (error) => error.code === 'asrFailed');

  const pending = transcriber.transcribe(Float32Array.from([0.1]), {
    sampleRate: ASR_SAMPLE_RATE,
  });
  transcriber.dispose();
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  assert.equal(worker.terminated, true);
});

test('isModelAvailable probes config.json and never throws', async () => {
  const seen = [];
  const target = 'https://app.test/models/whisper-tiny/';

  const present = await isModelAvailable(target, async (url) => {
    seen.push(url);
    return new Response('{"model_type":"whisper"}', { status: 200 });
  });
  assert.equal(present, true);
  assert.deepEqual(seen, [`${target}config.json`]);

  const absent = await isModelAvailable(target, async () => new Response('', { status: 404 }));
  assert.equal(absent, false);

  const offline = await isModelAvailable(target, async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(offline, false, 'a network failure means "not available", not a crash');
});

test(
  'ASR_MODEL_BYTES matches the installed model files',
  // The model is not committed: a fresh clone only has LICENSE until
  // `npm run models:download` runs, so key the skip off an actual graph file.
  { skip: !existsSync(join(dirname(fileURLToPath(import.meta.url)), MODEL_DIR, ENCODER_FILE)) },
  () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), MODEL_DIR);
    const files = readdirSync(root, { withFileTypes: true, recursive: true }).filter(
      // The licence is documentation, not part of what the worker downloads.
      (entry) => entry.isFile() && entry.name !== 'LICENSE',
    );
    const total = files.reduce(
      (sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size,
      0,
    );
    assert.equal(
      ASR_MODEL_BYTES,
      total,
      'the size quoted to the user must match what is stored on disk',
    );
  },
);
