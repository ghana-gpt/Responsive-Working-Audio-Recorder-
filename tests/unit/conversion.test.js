import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSION_STAGES,
  ConversionCancelledError,
  clampFraction,
  createConversionTask,
  isConversionCancelled,
} from '../../scripts/modules/conversion.js';
import { encodeWav, encodeWavAsync, sliceChannels } from '../../scripts/modules/wav.js';

const SAMPLE_RATE = 8000;

/** Deterministic pseudo-random samples, including out-of-range values. */
function noisyChannel(frames, seed = 7) {
  const channel = new Float32Array(frames);
  let state = seed;
  for (let index = 0; index < frames; index += 1) {
    state = (state * 1103515245 + 12345) % 0x80000000;
    // -1.4..1.4 so the clamping in floatToPcm16 is exercised too.
    channel[index] = (state / 0x3fffffff - 1) * 1.4;
  }
  return channel;
}

/** Minimal AbortSignal stand-in so listener cleanup is observable. */
function fakeSignal() {
  const listeners = new Set();
  return {
    aborted: false,
    addEventListener: (type, listener) => {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === 'abort') listeners.delete(listener);
    },
    abort() {
      this.aborted = true;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

test('clampFraction keeps values inside 0..1', () => {
  assert.equal(clampFraction(0.5), 0.5);
  assert.equal(clampFraction(-3), 0);
  assert.equal(clampFraction(9), 1);
  assert.equal(clampFraction('0.25'), 0.25);
  assert.equal(clampFraction(Number.NaN), 0);
  assert.equal(clampFraction(undefined), 0);
});

test('progress never moves backwards inside a stage and resets when the stage changes', () => {
  /** @type {{ stage: string, fraction: number|null }[]} */
  const updates = [];
  const task = createConversionTask({ onProgress: (update) => updates.push(update) });

  task.report(CONVERSION_STAGES.DECODE, null);
  task.report(CONVERSION_STAGES.ENCODE, 0.1);
  task.report(CONVERSION_STAGES.ENCODE, 0.8);
  task.report(CONVERSION_STAGES.ENCODE, 0.2); // jitter: clamped to 0.8
  task.report(CONVERSION_STAGES.ENCODE, 4); // clamped to 1
  task.report(CONVERSION_STAGES.DECODE, null); // new stage resets the floor

  assert.deepEqual(
    updates.map((update) => update.fraction),
    [null, 0.1, 0.8, 0.8, 1, null],
  );
  assert.deepEqual(
    updates.map((update) => update.stage),
    ['decode', 'encode', 'encode', 'encode', 'encode', 'decode'],
  );
  task.dispose();
});

test('cancellation raises a distinguishable error', () => {
  const signal = new AbortController();
  const task = createConversionTask({ signal: signal.signal });

  task.throwIfCancelled(); // not cancelled yet

  signal.abort();
  assert.equal(task.cancelled, true);
  assert.throws(
    () => task.throwIfCancelled(),
    (error) => {
      assert.ok(error instanceof ConversionCancelledError);
      assert.equal(error.name, 'ConversionCancelledError');
      assert.equal(error.code, 'conversionCancelled');
      assert.equal(isConversionCancelled(error), true);
      return true;
    },
  );

  // A platform AbortError (different realm, no instanceof) counts too.
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  assert.equal(isConversionCancelled(abortError), true);
  assert.equal(isConversionCancelled(new Error('boom')), false);
  assert.equal(isConversionCancelled(null), false);
  task.dispose();
});

test('a signal that is already aborted cancels immediately', () => {
  const signal = fakeSignal();
  signal.abort();
  const task = createConversionTask({ signal });
  assert.equal(task.cancelled, true);
  assert.throws(() => task.throwIfCancelled(), ConversionCancelledError);
  task.dispose();
});

test('dispose removes the abort listener and stops reporting', () => {
  const signal = fakeSignal();
  const updates = [];
  const task = createConversionTask({ signal, onProgress: (update) => updates.push(update) });

  assert.equal(signal.listenerCount, 1);
  task.report('encode', 0.5);
  task.dispose();
  assert.equal(signal.listenerCount, 0, 'the listener is released');
  // Cancelling after dispose is still visible through `signal.aborted`, but the
  // task no longer reports or reacts to anything.
  signal.abort();
  task.report('encode', 0.9);
  assert.equal(updates.length, 1, 'no progress after dispose');
  task.dispose(); // idempotent
  assert.equal(signal.listenerCount, 0);
});

test('encodeWavAsync produces exactly the same bytes as encodeWav', async () => {
  const mono = noisyChannel(5000);
  const stereo = [noisyChannel(4000, 3), noisyChannel(4000, 11)];

  for (const [channels, rate] of [
    [[mono], SAMPLE_RATE],
    [stereo, 44100],
  ]) {
    const sync = encodeWav(channels, rate);
    const asyncBuffer = await encodeWavAsync(channels, rate, {
      chunkFrames: 777,
      yieldFn: async () => {},
    });
    assert.deepEqual(
      new Uint8Array(asyncBuffer),
      new Uint8Array(sync),
      'chunked encoding must be byte identical',
    );
  }
});

test('encodeWavAsync reports monotonic progress ending at 1', async () => {
  const channel = noisyChannel(1000);
  /** @type {number[]} */
  const fractions = [];
  const buffer = await encodeWavAsync([channel], SAMPLE_RATE, {
    chunkFrames: 100,
    yieldFn: async () => {},
    onProgress: (fraction) => fractions.push(fraction),
  });

  assert.equal(buffer.byteLength, 44 + 1000 * 2);
  assert.equal(fractions[0], 0, 'progress starts at zero');
  assert.equal(fractions.at(-1), 1, 'progress ends at one');
  assert.ok(fractions.length >= 5, 'each chunk reports');
  for (let index = 1; index < fractions.length; index += 1) {
    assert.ok(fractions[index] >= fractions[index - 1], 'progress never regresses');
  }
});

test('encodeWavAsync yields between chunks but not after the last one', async () => {
  let yields = 0;
  await encodeWavAsync([noisyChannel(500)], SAMPLE_RATE, {
    chunkFrames: 100,
    yieldFn: async () => {
      yields += 1;
    },
  });
  assert.equal(yields, 4, 'five chunks need four yields');
});

test('encodeWavAsync stops promptly when cancelled mid-encode', async () => {
  const controller = new AbortController();
  const channel = noisyChannel(5000);
  let reported = 0;

  await assert.rejects(
    encodeWavAsync([channel], SAMPLE_RATE, {
      signal: controller.signal,
      chunkFrames: 500,
      yieldFn: async () => {},
      onProgress: (fraction) => {
        reported = fraction;
        if (fraction >= 0.3) controller.abort();
      },
    }),
    (error) => isConversionCancelled(error),
  );

  assert.ok(reported >= 0.3, 'the encoder had started before the cancel');
  assert.ok(reported < 1, 'it stopped before finishing the file');
});

test('encodeWavAsync refuses to start on an already aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    encodeWavAsync([noisyChannel(100)], SAMPLE_RATE, {
      signal: controller.signal,
      yieldFn: async () => {},
    }),
    (error) => error instanceof ConversionCancelledError,
  );
});

test('encodeWavAsync validates input and handles empty channels', async () => {
  await assert.rejects(encodeWavAsync([], SAMPLE_RATE), TypeError);
  await assert.rejects(encodeWavAsync([noisyChannel(10)], 0), TypeError);
  await assert.rejects(encodeWavAsync([noisyChannel(10), noisyChannel(9)], SAMPLE_RATE), TypeError);

  const empty = await encodeWavAsync([new Float32Array(0)], SAMPLE_RATE, {
    yieldFn: async () => {},
  });
  assert.equal(empty.byteLength, 44, 'header only');
});

test('a trimmed range encodes like the sliced buffers (trim path)', async () => {
  const channel = noisyChannel(2000);
  const sliced = sliceChannels([channel], SAMPLE_RATE, 0.05, 0.15);
  const trimmed = await encodeWavAsync(sliced, SAMPLE_RATE, {
    chunkFrames: 64,
    yieldFn: async () => {},
  });
  assert.deepEqual(new Uint8Array(trimmed), new Uint8Array(encodeWav(sliced, SAMPLE_RATE)));
});
