import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversionCancelledError } from '../../scripts/modules/conversion.js';
import { encodeMp3Async } from '../../scripts/modules/mp3.js';

const fakeEncoder = ({ onEncode = () => {}, onFlush = () => {} } = {}) => ({
  encodeBuffer(left, right) {
    onEncode(left, right);
    return new Int8Array([left.length & 0x7f]);
  },
  flush() {
    onFlush();
    return new Int8Array([127]);
  },
});

test('encodeMp3Async converts mono float samples and reports frame progress', async () => {
  const progress = [];
  const samples = new Float32Array([0, 0.5, -1, 1, 0.25]);
  const encodedSamples = [];
  let yieldCount = 0;
  const output = await encodeMp3Async([samples], 44_100, 96_000, {
    chunkFrames: 2,
    yieldFn: async () => {
      yieldCount += 1;
    },
    onProgress: (fraction) => progress.push(fraction),
    createEncoder: (channels, rate, bitrate) => {
      assert.deepEqual([channels, rate, bitrate], [1, 44_100, 96]);
      return fakeEncoder({
        onEncode: (left, right) => {
          assert.equal(right, undefined);
          encodedSamples.push(...left);
        },
      });
    },
  });

  assert.deepEqual(encodedSamples, [0, 16_384, -32_768, 32_767, 8_192]);
  assert.deepEqual(progress, [0, 0.4, 0.8, 1]);
  assert.equal(yieldCount, 2);
  assert.equal(output.type, 'audio/mpeg');
  assert.deepEqual(Array.from(new Uint8Array(await output.arrayBuffer())), [2, 2, 1, 127]);
});

test('encodeMp3Async preserves left and right channels for stereo', async () => {
  const left = new Float32Array([0.25, -0.5]);
  const right = new Float32Array([-0.25, 0.5]);
  let observed;

  await encodeMp3Async([left, right], 48_000, 128_000, {
    createEncoder: (channels, rate, bitrate) => {
      assert.deepEqual([channels, rate, bitrate], [2, 48_000, 128]);
      return fakeEncoder({
        onEncode: (leftChunk, rightChunk) => {
          observed = [Array.from(leftChunk), Array.from(rightChunk)];
        },
      });
    },
  });

  assert.deepEqual(observed, [
    [8_192, -16_384],
    [-8_192, 16_384],
  ]);
});

test('encodeMp3Async honours cancellation between chunks and discards partial output', async () => {
  const controller = new AbortController();
  let flushCount = 0;
  const conversion = encodeMp3Async([new Float32Array(5)], 44_100, 96_000, {
    signal: controller.signal,
    chunkFrames: 2,
    yieldFn: async () => controller.abort(),
    createEncoder: () => fakeEncoder({ onFlush: () => (flushCount += 1) }),
  });

  await assert.rejects(conversion, ConversionCancelledError);
  assert.equal(flushCount, 0);
});

test('encodeMp3Async can cancel while the local encoder is loading', async () => {
  const controller = new AbortController();
  let resolveEncoder;
  let encodeCount = 0;
  const conversion = encodeMp3Async([new Float32Array([0])], 44_100, 96_000, {
    signal: controller.signal,
    createEncoder: () =>
      new Promise((resolve) => {
        resolveEncoder = resolve;
      }),
  });

  await Promise.resolve();
  controller.abort();
  await assert.rejects(conversion, ConversionCancelledError);
  resolveEncoder(fakeEncoder({ onEncode: () => (encodeCount += 1) }));
  await Promise.resolve();
  assert.equal(encodeCount, 0);
});

test('encodeMp3Async rejects invalid channels, sample rates, bitrates and empty audio', async () => {
  const valid = new Float32Array([0]);
  const encoder = () => fakeEncoder();

  await assert.rejects(encodeMp3Async([], 44_100, 96_000), TypeError);
  await assert.rejects(encodeMp3Async([valid, valid, valid], 44_100, 96_000), TypeError);
  await assert.rejects(encodeMp3Async([valid], 7_999, 96_000), RangeError);
  await assert.rejects(encodeMp3Async([valid], 44_100, 7_000), RangeError);
  await assert.rejects(encodeMp3Async([new Float32Array(0)], 44_100, 96_000), RangeError);
  await assert.rejects(
    encodeMp3Async([new Float32Array([0]), new Float32Array(0)], 44_100, 96_000),
    TypeError,
  );
  assert.equal(typeof encoder, 'function');
});
