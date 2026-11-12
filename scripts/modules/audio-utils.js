/**
 * Browser audio helpers: decoding, WAV conversion, waveform peaks, downloads,
 * sharing and clipboard access.
 */

import { computePeaks, encodeWav, sliceChannels } from './wav.js';

/** @type {AudioContext|null} */
let sharedContext = null;

/**
 * Lazily create a single AudioContext (browsers limit how many you may create).
 * @returns {AudioContext}
 */
export function getAudioContext() {
  if (sharedContext) return sharedContext;
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context) throw new Error('Web Audio API is not available');
  sharedContext = new Context();
  return sharedContext;
}

/**
 * Decode any recorded blob into raw PCM channels.
 * Uses the promise form when available and falls back to the callback form.
 *
 * @param {Blob} blob
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlob(blob) {
  const context = getAudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onSuccess = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('decodeAudioData failed'));
    };
    try {
      const maybePromise = context.decodeAudioData(arrayBuffer, onSuccess, onError);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(onSuccess, onError);
      }
    } catch (error) {
      onError(error);
    }
  });
}

/**
 * Copy an AudioBuffer's channels into plain Float32Arrays.
 * @param {AudioBuffer} buffer
 * @returns {Float32Array[]}
 */
export function extractChannels(buffer) {
  const channels = [];
  for (let index = 0; index < buffer.numberOfChannels; index += 1) {
    const data = new Float32Array(buffer.length);
    buffer.copyFromChannel(data, index);
    channels.push(data);
  }
  return channels;
}

/**
 * Encode channels as a WAV blob.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Blob}
 */
export function channelsToWavBlob(channels, sampleRate) {
  return new Blob([encodeWav(channels, sampleRate)], { type: 'audio/wav' });
}

/**
 * Convert any supported recording to 16-bit PCM WAV.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
export async function convertToWav(blob) {
  const buffer = await decodeBlob(blob);
  return channelsToWavBlob(extractChannels(buffer), buffer.sampleRate);
}

/**
 * Decode a blob and compute a peak envelope for the trim dialog waveform.
 * @param {Blob} blob
 * @param {number} [buckets]
 * @returns {Promise<{ peaks: { min: Float32Array, max: Float32Array }, duration: number, sampleRate: number }>}
 */
export async function analyzeWaveform(blob, buckets = 240) {
  const buffer = await decodeBlob(blob);
  const channels = extractChannels(buffer);
  return {
    peaks: computePeaks(channels, buckets),
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
  };
}

/**
 * Produce a trimmed WAV copy of a recording.
 *
 * @param {Blob} blob original recording
 * @param {number} startSeconds
 * @param {number} endSeconds
 * @returns {Promise<{ blob: Blob, duration: number }>}
 */
export async function trimToWav(blob, startSeconds, endSeconds) {
  const buffer = await decodeBlob(blob);
  const channels = extractChannels(buffer);
  const sliced = sliceChannels(channels, buffer.sampleRate, startSeconds, endSeconds);
  return {
    blob: channelsToWavBlob(sliced, buffer.sampleRate),
    duration: sliced[0].length / buffer.sampleRate,
  };
}

/**
 * Trigger a browser download for a blob and release the object URL afterwards.
 * Object URLs are revoked here so long sessions do not leak memory.
 *
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Wrap a blob in a File so the Web Share API can share it.
 * @param {Blob} blob
 * @param {string} filename
 * @returns {File|Blob}
 */
export function toFile(blob, filename) {
  try {
    return new File([blob], filename, { type: blob.type || 'audio/webm' });
  } catch {
    // Very old Safari has no File constructor: reuse the blob.
    return blob;
  }
}

/**
 * Share a recording through the OS share sheet when available.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ title?: string, text?: string }} [meta]
 * @returns {Promise<'shared'|'unsupported'|'cancelled'>}
 */
export async function shareRecording(blob, filename, meta = {}) {
  const file = toFile(blob, filename);
  try {
    if (typeof navigator.canShare !== 'function' || !navigator.share) return 'unsupported';
    if (!navigator.canShare({ files: [file] })) return 'unsupported';
    await navigator.share({ files: [file], title: meta.title, text: meta.text });
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    return 'unsupported';
  }
}
