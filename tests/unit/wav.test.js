import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WAV_HEADER_BYTES,
  computePeaks,
  encodeWav,
  floatToPcm16,
  sliceChannels,
  wavByteLength,
} from '../../scripts/modules/wav.js';

const SAMPLE_RATE = 8000;

/** Generate a sine wave so encoders/decoders have real data to chew on. */
function sine(frequency, seconds, sampleRate = SAMPLE_RATE) {
  const frames = Math.round(seconds * sampleRate);
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    channel[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5;
  }
  return channel;
}

const ascii = (view, offset, length) =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');

test('floatToPcm16 clamps and scales correctly', () => {
  assert.equal(floatToPcm16(0), 0);
  assert.equal(floatToPcm16(1), 32767);
  assert.equal(floatToPcm16(-1), -32768);
  assert.equal(floatToPcm16(2), 32767);
  assert.equal(floatToPcm16(-2), -32768);
  assert.equal(floatToPcm16(Number.NaN), 0);
  assert.equal(Math.round(floatToPcm16(0.5)), 16384);
});

test('encodeWav writes a valid RIFF/WAVE PCM header', () => {
  const channel = sine(440, 0.25);
  const buffer = encodeWav([channel], SAMPLE_RATE);
  const view = new DataView(buffer);

  assert.equal(ascii(view, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
  assert.equal(ascii(view, 8, 4), 'WAVE');
  assert.equal(ascii(view, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1, 'PCM format tag');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), SAMPLE_RATE * 2, 'byte rate');
  assert.equal(view.getUint16(32, true), 2, 'block align');
  assert.equal(view.getUint16(34, true), 16, 'bits per sample');
  assert.equal(ascii(view, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), channel.length * 2);
  assert.equal(buffer.byteLength, WAV_HEADER_BYTES + channel.length * 2);
  assert.equal(buffer.byteLength, wavByteLength([channel]));
});

test('encodeWav supports stereo and rejects invalid input', () => {
  const left = sine(220, 0.1);
  const right = sine(330, 0.1);
  const buffer = encodeWav([left, right], 44100);
  const view = new DataView(buffer);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(28, true), 44100 * 4);
  assert.equal(view.getUint16(32, true), 4);
  assert.equal(view.getUint32(40, true), left.length * 4);

  assert.throws(() => encodeWav([], 44100), TypeError);
  assert.throws(() => encodeWav([left], 0), TypeError);
  assert.throws(() => encodeWav([left, new Float32Array(4)], 44100), TypeError);
  assert.throws(
    () =>
      encodeWav(
        [new Float32Array([0])].map(() => [0]),
        44100,
      ),
    TypeError,
  );
});

test('sliceChannels extracts a range and clamps to the buffer', () => {
  const channel = new Float32Array(1000).map((_, i) => i);
  const sliced = sliceChannels([channel], 100, 1, 3)[0];
  assert.equal(sliced.length, 200);
  assert.equal(sliced[0], 100);
  assert.equal(sliced[sliced.length - 1], 299);

  const clamped = sliceChannels([channel], 100, -5, 999)[0];
  assert.equal(clamped.length, 1000);
  assert.equal(clamped[0], 0);

  // end <= start still yields at least one frame so encoding never fails
  const tiny = sliceChannels([channel], 100, 5, 5)[0];
  assert.equal(tiny.length, 1);
});

test('computePeaks returns min/max buckets matching the data', () => {
  const channel = new Float32Array(1000);
  channel[0] = -1;
  channel[500] = 1;
  const { min, max } = computePeaks([channel], 10);
  assert.equal(min.length, 10);
  assert.equal(max.length, 10);
  assert.ok(Math.min(...min) <= -0.9);
  assert.ok(Math.max(...max) >= 0.9);
  assert.deepEqual(Array.from(computePeaks([], 3).max), [0, 0, 0]);
});

test('encoded WAV is decodable by ffmpeg (integration)', () => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    console.warn('ffprobe not available — skipping decoder check');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'wav-test-'));
  try {
    const channel = sine(440, 0.5, 16000);
    const file = join(directory, 'tone.wav');
    writeFileSync(file, new Uint8Array(encodeWav([channel], 16000)));
    const output = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,sample_rate,channels,duration',
      '-of',
      'default=noprint_wrappers=1',
      file,
    ]).toString();
    assert.match(output, /codec_name=pcm_s16le/);
    assert.match(output, /sample_rate=16000/);
    assert.match(output, /channels=1/);
    assert.match(output, /duration=0\.5/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
