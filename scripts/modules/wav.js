/**
 * Minimal, dependency free 16-bit PCM WAV encoder plus helpers used for the
 * "Trim" feature and for the "WAV" output format.
 *
 * MediaRecorder cannot emit WAV in any browser, so the app captures the best
 * compressed container available and converts it here after decoding with the
 * Web Audio API. Everything in this file is pure (typed arrays only) so it is
 * covered by tests/unit/wav.test.js.
 */

export const WAV_HEADER_BYTES = 44;

/**
 * Clamp a float sample to the signed 16-bit range.
 * @param {number} sample
 * @returns {number}
 */
export function floatToPcm16(sample) {
  const clamped = Math.max(-1, Math.min(1, Number(sample) || 0));
  // Asymmetric scaling keeps +1.0 from wrapping to -32768.
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/**
 * Encode one or more Float32 channel buffers as a RIFF/WAVE PCM16 file.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError('encodeWav: at least one channel is required');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError('encodeWav: a positive sampleRate is required');
  }

  const channelCount = channels.length;
  const frameCount = channels[0].length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new TypeError('encodeWav: channels must be Float32Array instances');
    }
    if (channel.length !== frameCount) {
      throw new TypeError('encodeWav: all channels must have the same length');
    }
  }

  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      view.setInt16(offset, Math.round(floatToPcm16(channels[channel][frame])), true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

/**
 * Slice every channel to [startSeconds, endSeconds).
 * Values are clamped to the buffer and a minimum of one frame is guaranteed so
 * `encodeWav` never receives empty arrays.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} startSeconds
 * @param {number} endSeconds
 * @returns {Float32Array[]}
 */
export function sliceChannels(channels, sampleRate, startSeconds, endSeconds) {
  const total = channels[0]?.length ?? 0;
  const start = Math.max(0, Math.min(total, Math.floor((Number(startSeconds) || 0) * sampleRate)));
  const rawEnd = Number.isFinite(Number(endSeconds))
    ? Math.floor(Number(endSeconds) * sampleRate)
    : total;
  const end = Math.max(start + 1, Math.min(total, rawEnd));
  return channels.map((channel) => channel.slice(start, end));
}

/**
 * Peak envelope (min/max per bucket) used to draw the trim waveform.
 *
 * @param {Float32Array[]} channels
 * @param {number} bucketCount
 * @returns {{ min: Float32Array, max: Float32Array }}
 */
export function computePeaks(channels, bucketCount = 200) {
  const frameCount = channels[0]?.length ?? 0;
  const buckets = Math.max(1, Math.floor(bucketCount));
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  if (frameCount === 0) return { min, max };

  const framesPerBucket = frameCount / buckets;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const startFrame = Math.floor(bucket * framesPerBucket);
    const endFrame = Math.max(startFrame + 1, Math.floor((bucket + 1) * framesPerBucket));
    let lowest = 0;
    let highest = 0;
    for (let frame = startFrame; frame < endFrame && frame < frameCount; frame += 1) {
      for (const channel of channels) {
        const sample = channel[frame];
        if (sample < lowest) lowest = sample;
        if (sample > highest) highest = sample;
      }
    }
    min[bucket] = lowest;
    max[bucket] = highest;
  }
  return { min, max };
}

/**
 * Byte length that `encodeWav` will produce for the given buffers.
 * @param {Float32Array[]} channels
 * @returns {number}
 */
export function wavByteLength(channels) {
  const frames = channels[0]?.length ?? 0;
  return WAV_HEADER_BYTES + frames * channels.length * 2;
}
