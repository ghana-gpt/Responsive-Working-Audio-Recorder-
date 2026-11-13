import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_MAX_SECONDS,
  LIVE_MIN_SECONDS,
  createLiveTranscript,
} from '../../scripts/modules/live-transcript.js';

const RATE = 16_000;
/** Let the module's `run()` promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Controllable `transcribe`: every call gets its own deferred resolution. */
function deferredTranscribe() {
  const calls = [];
  const transcribe = (samples, options) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({ samples, options, resolve, reject });
    return promise;
  };
  return { calls, transcribe };
}

test('the exported thresholds describe the preview cadence', () => {
  assert.equal(LIVE_MIN_SECONDS, 4);
  assert.equal(LIVE_MAX_SECONDS, 15);
  assert.ok(LIVE_MIN_SECONDS < LIVE_MAX_SECONDS);
});

test('nothing is decoded below the minimum slice length', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const live = createLiveTranscript({ transcribe });

  live.push(new Float32Array(RATE), RATE);
  live.push(new Float32Array(RATE), RATE);
  await flush();

  assert.equal(calls.length, 0, 'two seconds is not worth decoding');
  assert.equal(live.pendingSeconds(), 2);
});

test('a full slice is decoded once and appended to the caption', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const updates = [];
  const live = createLiveTranscript({
    transcribe,
    onUpdate: (state) => updates.push({ ...state }),
  });

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.sampleRate, RATE);
  assert.equal(live.isBusy(), true);
  assert.deepEqual(updates.at(-1), { text: '', busy: true });

  calls[0].resolve({ text: '  bonjour   tout le monde ' });
  await flush();

  assert.equal(live.getText(), 'bonjour tout le monde');
  assert.equal(live.isBusy(), false);
  assert.deepEqual(updates.at(-1), { text: 'bonjour tout le monde', busy: false });
});

test('a long push is cut to the maximum slice length', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const live = createLiveTranscript({ transcribe });

  live.push(new Float32Array(RATE * 20), RATE);
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].samples.length, RATE * LIVE_MAX_SECONDS);
  assert.ok(Math.abs(live.pendingSeconds() - 5) < 1e-6, 'the rest stays buffered');
});

test('a push while a slice is decoding queues exactly one follow-up', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const live = createLiveTranscript({ transcribe });

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();
  assert.equal(calls.length, 1);

  // Two more pushes arrive while the first slice is still decoding.
  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  live.push(new Float32Array(RATE), RATE);
  await flush();
  assert.equal(calls.length, 1, 'no second decode starts while busy');

  calls[0].resolve({ text: 'first' });
  await flush();
  assert.equal(calls.length, 2, 'the queued audio is decoded once');

  calls[1].resolve({ text: 'second' });
  await flush();
  assert.equal(live.getText(), 'first second');
});

test('a failed slice disables the preview without throwing', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const errors = [];
  const live = createLiveTranscript({ transcribe, onError: (error) => errors.push(error) });

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();
  const failure = new Error('model unavailable');
  calls[0].reject(failure);
  await flush();

  assert.deepEqual(errors, [failure]);
  assert.equal(live.getText(), '');
  assert.equal(live.isBusy(), false);

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();
  assert.equal(calls.length, 1, 'a dead preview does not try again');
});

test('reset() forgets the caption and stop() ignores late results', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const live = createLiveTranscript({ transcribe });

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();
  calls[0].resolve({ text: 'old capture' });
  await flush();
  assert.equal(live.getText(), 'old capture');

  live.reset();
  assert.equal(live.getText(), '');
  assert.equal(live.pendingSeconds(), 0);

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();
  assert.equal(calls.length, 2);

  live.stop();
  calls[1].resolve({ text: 'too late' });
  await flush();
  assert.equal(live.getText(), '', 'a stopped preview keeps its text frozen');

  live.push(new Float32Array(RATE * LIVE_MIN_SECONDS), RATE);
  await flush();
  assert.equal(calls.length, 2, 'pushes are ignored after stop()');
});

test('a new sample rate starts a fresh session', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const live = createLiveTranscript({ transcribe });

  live.push(new Float32Array(44_100), 44_100);
  assert.ok(Math.abs(live.pendingSeconds() - 1) < 1e-6);
  live.push(new Float32Array(48_000), 48_000);

  assert.ok(Math.abs(live.pendingSeconds() - 1) < 1e-6, 'the old buffer was dropped');
  await flush();
  assert.equal(calls.length, 0);
});

test('invalid pushes are ignored', async () => {
  const { calls, transcribe } = deferredTranscribe();
  const live = createLiveTranscript({ transcribe });

  live.push(new Float32Array(0), RATE);
  live.push(new Float32Array(RATE), 0);
  live.push(null, RATE);
  await flush();

  assert.equal(calls.length, 0);
  assert.equal(live.pendingSeconds(), 0);
});
