import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ConversionCancelledError } from '../../scripts/modules/conversion.js';
import {
  MP3_BITRATES,
  MP3_ENCODER_AVAILABLE,
  MP3_SAMPLE_RATES,
  encodeMp3Async,
} from '../../scripts/modules/mp3.js';
import {
  Mp3WasmEncoder,
  assertMp3Exports,
  instantiateMp3Wasm,
} from '../../scripts/modules/mp3-wasm.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WASM_PATH = join(ROOT, 'vendor/audiobox/mp3-encoder.wasm');
const BUILD_INFO_PATH = join(ROOT, 'vendor/audiobox/build-info.json');

/**
 * Stand-in for the worker-backed encoder: records what the wrapper asked for and
 * plays back a scripted result.
 *
 * @param {{
 *   bytes?: Uint8Array,
 *   onEncode?: (planes: Float32Array[], options: object) => void,
 *   onDispose?: () => void,
 *   manual?: boolean,
 * }} [options] `manual` keeps the encode promise pending, like a worker that is
 * terminated before it can answer.
 */
function fakeEncoder({
  bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]),
  onEncode,
  onDispose,
  manual = false,
} = {}) {
  const calls = { encode: 0, dispose: 0 };
  /** @type {((value: Uint8Array) => void)|null} */
  let finish = null;
  const encoder = {
    calls,
    /** @type {Float32Array[]|null} */
    planes: null,
    /** @type {object|null} */
    options: null,
    encode(planes, options) {
      calls.encode += 1;
      encoder.planes = planes;
      encoder.options = options;
      if (onEncode) onEncode(planes, options);
      if (manual) {
        return new Promise((resolvePromise) => {
          finish = resolvePromise;
        });
      }
      return Promise.resolve(bytes);
    },
    /** Release a `manual` encode, if the test wants it to finish after all. */
    finish() {
      if (finish) finish(bytes);
    },
    dispose() {
      calls.dispose += 1;
      if (onDispose) onDispose();
    },
  };
  return encoder;
}

/** @param {number} frames @param {number} [channels] */
function ramp(frames, channels = 1) {
  return Array.from({ length: channels }, (_, channel) =>
    Float32Array.from({ length: frames }, (_, index) => Math.sin((index / 100) * (channel + 1))),
  );
}

test('the app always reports the MP3 encoder as available', () => {
  assert.equal(MP3_ENCODER_AVAILABLE, true);
  assert.deepEqual([...MP3_SAMPLE_RATES], [32_000, 44_100, 48_000]);
  assert.ok(MP3_BITRATES.includes(96_000));
  assert.ok(MP3_BITRATES.includes(320_000));
  assert.equal(MP3_BITRATES.length, 14, 'the full MPEG-1 Layer III table');
});

test('encodeMp3Async hands the channels, rate and bitrate to the encoder', async () => {
  const progress = [];
  const encoder = fakeEncoder();
  const channels = ramp(2048, 2);

  const blob = await encodeMp3Async(channels, 44_100, 128_000, {
    createEncoder: () => encoder,
    onProgress: (fraction) => progress.push(fraction),
  });

  assert.equal(encoder.calls.encode, 1);
  assert.equal(encoder.calls.dispose, 1, 'the worker is released once');
  assert.deepEqual(encoder.planes, channels, 'planar samples are passed through untouched');
  assert.equal(encoder.options.sampleRate, 44_100);
  assert.equal(encoder.options.bitrateKbps, 128, 'the encoder speaks kbit/s');
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [0xff, 0xfb, 0x90, 0x00]);
  assert.deepEqual(progress, [0, 1], 'zero before, one after — nothing invented in between');
});

test('encodeMp3Async forwards the encoder progress between 0 and 1', async () => {
  const progress = [];
  const encoder = fakeEncoder({
    onEncode: (_planes, options) => {
      options.onProgress(0.5);
      options.onProgress(null);
      options.onProgress(0.25);
    },
  });

  await encodeMp3Async(ramp(64), 48_000, 96_000, {
    createEncoder: () => encoder,
    onProgress: (fraction) => progress.push(fraction),
  });

  assert.deepEqual(progress, [0, 0.5, null, 0.25, 1]);
});

test('encodeMp3Async rejects when the encoder returns nothing', async () => {
  await assert.rejects(
    encodeMp3Async(ramp(32), 44_100, 96_000, {
      createEncoder: () => fakeEncoder({ bytes: new Uint8Array(0) }),
    }),
    /produced an empty file/,
  );
});

test('encodeMp3Async preserves an encoder failure and still releases the worker', async () => {
  const encoder = fakeEncoder({
    onEncode: () => {
      throw new Error('the encoder exploded');
    },
  });
  await assert.rejects(
    encodeMp3Async(ramp(32), 44_100, 96_000, { createEncoder: () => encoder }),
    /the encoder exploded/,
  );
  assert.equal(encoder.calls.dispose, 1);
});

test('encodeMp3Async refuses to start on an already aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let created = 0;
  await assert.rejects(
    encodeMp3Async(ramp(32), 44_100, 96_000, {
      signal: controller.signal,
      createEncoder: () => {
        created += 1;
        return fakeEncoder();
      },
    }),
    ConversionCancelledError,
  );
  assert.equal(created, 0, 'no worker is started for a cancelled export');
});

test('encodeMp3Async can be cancelled while the encoder is still loading', async () => {
  const controller = new AbortController();
  let releaseEncoder;
  const encoder = fakeEncoder();

  const conversion = encodeMp3Async(ramp(32), 44_100, 96_000, {
    signal: controller.signal,
    createEncoder: () =>
      new Promise((resolvePromise) => {
        releaseEncoder = resolvePromise;
      }),
  });

  await Promise.resolve();
  controller.abort();
  await assert.rejects(conversion, ConversionCancelledError);

  releaseEncoder(encoder);
  await Promise.resolve();
  assert.equal(encoder.calls.encode, 0, 'no encoding starts after the cancel');
});

test('cancelling mid-encode terminates the encoder and reports a cancellation', async () => {
  const controller = new AbortController();
  // A terminated worker never answers, so the encode promise stays pending.
  const encoder = fakeEncoder({ manual: true });

  const conversion = encodeMp3Async(ramp(512), 44_100, 96_000, {
    signal: controller.signal,
    createEncoder: () => encoder,
    onProgress: (fraction) => {
      if (fraction === 0.5) controller.abort();
    },
  });

  // The encoder is created on a microtask, so wait for it before driving it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(encoder.calls.encode, 1, 'the encode is in flight');
  encoder.options.onProgress(0.5);

  await assert.rejects(conversion, ConversionCancelledError);
  assert.ok(encoder.calls.dispose >= 1, 'the worker is torn down, killing the WASM call');
});

test('encodeMp3Async validates channels, sample rates, bitrates and empty audio', async () => {
  const valid = new Float32Array([0]);

  await assert.rejects(encodeMp3Async([], 44_100, 96_000), TypeError);
  await assert.rejects(encodeMp3Async([valid, valid, valid], 44_100, 96_000), TypeError);
  await assert.rejects(encodeMp3Async([valid], 7_999, 96_000), RangeError);
  await assert.rejects(encodeMp3Async([valid], 22_050, 96_000), RangeError);
  await assert.rejects(encodeMp3Async([valid], 44_100, 7_000), RangeError);
  await assert.rejects(encodeMp3Async([valid], 44_100, 128_001), RangeError);
  await assert.rejects(encodeMp3Async([new Float32Array(0)], 44_100, 96_000), RangeError);
  await assert.rejects(
    encodeMp3Async([new Float32Array([0]), new Float32Array(0)], 44_100, 96_000),
    TypeError,
  );
  await assert.rejects(encodeMp3Async([new Int16Array(4)], 44_100, 96_000), TypeError);
});

/* ------------------------------------------------------------------ *
 * The committed WebAssembly binary
 * ------------------------------------------------------------------ */

/** MPEG-1 Layer III bitrates by header index (index 0 is "free"). */
const BITRATE_TABLE = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** MPEG-1 sample rates by header index (index 3 is reserved). */
const SAMPLE_RATE_TABLE = [44_100, 48_000, 32_000];

const wasmBytes = new Uint8Array(readFileSync(WASM_PATH));
const buildInfo = JSON.parse(readFileSync(BUILD_INFO_PATH, 'utf8'));

/**
 * Read four ASCII bytes, or `''` when they fall outside the buffer.
 *
 * @param {Uint8Array} bytes
 * @param {number} start
 */
function ascii(bytes, start) {
  let text = '';
  for (let index = start; index < start + 4; index += 1) {
    if (index >= bytes.length) return '';
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

/**
 * Walk every frame of an MPEG-1 Layer III stream.
 *
 * This is deliberately independent of the encoder: it parses the headers by hand
 * the way a decoder would, so a wrong header, a truncated stream or a mismatched
 * CBR bitrate fails the test instead of being taken on trust.
 *
 * @param {Uint8Array} bytes
 * @returns {{ frames: number, bitrates: number[], sampleRate: number, channels: number, infoFrames: number }}
 */
function inspectMp3(bytes) {
  let offset = 0;
  let frames = 0;
  let infoFrames = 0;
  let sampleRate = 0;
  let channels = 0;
  const bitrates = new Set();

  while (offset < bytes.length) {
    const start = offset;
    assert.ok(
      bytes[start] === 0xff && (bytes[start + 1] & 0xe0) === 0xe0,
      `frame ${frames} starts with a sync word at byte ${start}`,
    );
    const version = (bytes[start + 1] >> 3) & 0x03;
    const layer = (bytes[start + 1] >> 1) & 0x03;
    assert.equal(version, 0b11, 'the stream is MPEG-1');
    assert.equal(layer, 0b01, 'the stream is Layer III');

    const bitrateKbps = BITRATE_TABLE[bytes[start + 2] >> 4];
    const rate = SAMPLE_RATE_TABLE[(bytes[start + 2] >> 2) & 0x03];
    const padding = (bytes[start + 2] >> 1) & 0x01;
    const channelMode = bytes[start + 3] >> 6;
    assert.ok(bitrateKbps > 0, 'no free-format bitrate');
    assert.ok(rate > 0, 'no reserved sample rate');

    const length = Math.floor((144 * bitrateKbps * 1000) / rate) + padding;
    offset += length;
    assert.ok(offset <= bytes.length, `frame ${frames} is complete`);

    // The first frame may only carry the Xing/Info header (and the LAME tag that
    // makes the stream gapless); it has no audio and its bitrate is free.
    const sideInfo = channelMode === 0b11 ? 17 : 32;
    const tag = ascii(bytes, start + 4 + sideInfo);
    if (tag === 'Xing' || tag === 'Info') {
      infoFrames += 1;
    } else {
      bitrates.add(bitrateKbps);
    }

    sampleRate = rate;
    channels = channelMode === 0b11 ? 1 : 2;
    frames += 1;
  }

  assert.equal(offset, bytes.length, 'the stream ends exactly on a frame boundary');
  return { frames, infoFrames, bitrates: [...bitrates], sampleRate, channels };
}

test('the committed binary matches the digest the build script recorded', () => {
  assert.equal(
    createHash('sha256').update(wasmBytes).digest('hex'),
    buildInfo.artifact.sha256,
    'vendor/audiobox/mp3-encoder.wasm is the build recorded in build-info.json',
  );
  assert.equal(wasmBytes.length, buildInfo.artifact.bytes, 'the recorded size is the real size');
  assert.match(buildInfo.sources.sha256, /^[0-9a-f]{64}$/);
});

test('the binary needs no imports and exports the whole bridge ABI', async () => {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const exports = instance.exports;
  assert.ok(exports.memory instanceof WebAssembly.Memory);
  for (const name of [
    'abx_input',
    'abx_encode',
    'abx_output_ptr',
    'abx_output_len',
    'abx_error_ptr',
    'abx_error_len',
  ]) {
    assert.equal(typeof exports[name], 'function', name);
  }
  assert.equal(assertMp3Exports(exports), exports);
});

test('assertMp3Exports explains what an incomplete module is missing', () => {
  assert.throws(() => assertMp3Exports(undefined), /exposes nothing/);
  assert.throws(
    () => assertMp3Exports({ memory: new WebAssembly.Memory({ initial: 1 }) }),
    /missing “abx_input”/,
  );
});

test('a refused encode returns 0 and leaves a readable message in the bridge', async () => {
  const exports = await instantiateMp3Wasm(wasmBytes);
  // Two channels of four frames need eight samples; none were supplied.
  assert.equal(exports.abx_encode(4, 2, 44_100, 128_000), 0);
  const length = exports.abx_error_len();
  assert.ok(length > 0);
  const message = new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, exports.abx_error_ptr(), length),
  );
  assert.match(message, /4 frames of 2 channels/);
});

test('the WASM encoder writes a valid stereo CBR MP3 at 128 kbit/s', async () => {
  const encoder = new Mp3WasmEncoder(await instantiateMp3Wasm(wasmBytes));
  const progress = [];
  const channels = ramp(44_100, 2);

  const bytes = await encoder.encode(channels, {
    sampleRate: 44_100,
    bitrateKbps: 128,
    onProgress: (fraction) => progress.push(fraction),
  });

  const stream = inspectMp3(bytes);
  assert.deepEqual(stream.bitrates, [128], 'constant bitrate');
  assert.equal(stream.sampleRate, 44_100);
  assert.equal(stream.channels, 2);
  const minimumFrames = Math.ceil(44_100 / 1152);
  assert.ok(
    stream.frames >= minimumFrames && stream.frames <= minimumFrames + 4,
    `one second needs about ${minimumFrames} frames, got ${stream.frames}`,
  );
  // 128 kbit/s over the same number of frames, within a frame of slack.
  const expectedBytes = (128_000 / 8) * ((stream.frames * 1152) / 44_100);
  assert.ok(Math.abs(bytes.length - expectedBytes) < 500);

  assert.ok(progress.every((fraction) => fraction === null || (fraction > 0 && fraction <= 1)));
  assert.ok(progress.includes(null), 'the encode itself reports unknown progress');
});

test('the same instance encodes mono at 32 kHz and stays reusable', async () => {
  const encoder = new Mp3WasmEncoder(await instantiateMp3Wasm(wasmBytes));
  const options = { sampleRate: 32_000, bitrateKbps: 32 };

  const first = inspectMp3(await encoder.encode(ramp(8_000), options));
  assert.deepEqual(first.bitrates, [32]);
  assert.equal(first.sampleRate, 32_000);
  assert.equal(first.channels, 1, 'a single plane is written as mono');

  const second = inspectMp3(await encoder.encode(ramp(16_000), options));
  assert.ok(second.frames > first.frames, 'the second encode is longer, not appended to');
});

test('the encoder wrapper validates its input and refuses use after dispose', async () => {
  const encoder = new Mp3WasmEncoder(await instantiateMp3Wasm(wasmBytes));

  await assert.rejects(encoder.encode([], { sampleRate: 44_100, bitrateKbps: 96 }), TypeError);
  await assert.rejects(
    encoder.encode(ramp(4, 3), { sampleRate: 44_100, bitrateKbps: 96 }),
    TypeError,
  );
  await assert.rejects(
    encoder.encode([new Float32Array(0)], { sampleRate: 44_100, bitrateKbps: 96 }),
    RangeError,
  );

  encoder.dispose();
  await assert.rejects(
    encoder.encode(ramp(16), { sampleRate: 44_100, bitrateKbps: 96 }),
    /has been closed/,
  );
});

/* ------------------------------------------------------------------ *
 * Independent validation with FFmpeg, when it is installed
 *
 * The app never runs these; they exist so the committed binary is checked
 * against a decoder that knows nothing about this project. They are skipped on
 * machines without FFmpeg rather than failing the suite.
 * ------------------------------------------------------------------ */

/** @param {string} name */
function isInstalled(name) {
  return spawnSync(name, ['-version'], { encoding: 'utf8' }).status === 0;
}

const FFPROBE_MISSING = isInstalled('ffprobe') ? false : 'ffprobe is not installed';
const FFMPEG_MISSING = isInstalled('ffmpeg') ? false : 'ffmpeg is not installed';

test(
  'ffprobe reads the output as 44.1 kHz stereo MP3 at 128 kbit/s',
  { skip: FFPROBE_MISSING },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mp3-encoder-'));
    const file = join(directory, 'reference.mp3');
    try {
      const encoder = new Mp3WasmEncoder(await instantiateMp3Wasm(wasmBytes));
      const bytes = await encoder.encode(ramp(44_100, 2), {
        sampleRate: 44_100,
        bitrateKbps: 128,
      });
      writeFileSync(file, bytes);

      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=codec_name,sample_rate,channels,bit_rate:format=duration',
          '-of',
          'json',
          file,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(probe.status, 0, probe.stderr);
      const { streams, format } = JSON.parse(probe.stdout);
      assert.equal(streams[0].codec_name, 'mp3');
      assert.equal(Number(streams[0].sample_rate), 44_100);
      assert.equal(streams[0].channels, 2);
      assert.ok(Math.abs(Number(streams[0].bit_rate) - 128_000) < 4_000, streams[0].bit_rate);
      assert.ok(Math.abs(Number(format.duration) - 1) < 0.1, format.duration);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'ffmpeg decodes the whole file without a warning and returns the samples',
  { skip: FFMPEG_MISSING },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mp3-encoder-'));
    const file = join(directory, 'reference.mp3');
    const frames = 22_050;
    try {
      const encoder = new Mp3WasmEncoder(await instantiateMp3Wasm(wasmBytes));
      const bytes = await encoder.encode(ramp(frames, 2), {
        sampleRate: 48_000,
        bitrateKbps: 96,
      });
      writeFileSync(file, bytes);

      const decode = spawnSync(
        'ffmpeg',
        ['-nostdin', '-v', 'error', '-i', file, '-f', 's16le', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      );
      assert.equal(decode.status, 0, String(decode.stderr));
      assert.equal(String(decode.stderr).trim(), '', 'no decoder complaints');

      // 16-bit stereo: four bytes per frame. The encoder writes a gapless tag,
      // so the decoder returns the input length rather than the padded one.
      const decodedFrames = decode.stdout.length / 4;
      assert.ok(
        Math.abs(decodedFrames - frames) <= 1152,
        `expected about ${frames} frames, decoded ${decodedFrames}`,
      );
      assert.ok(
        decode.stdout.some((byte) => byte !== 0),
        'the decoded audio is not silence',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
