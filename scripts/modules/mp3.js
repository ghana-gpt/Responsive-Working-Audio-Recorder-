/**
 * Same-origin MP3 encoder adapter.
 *
 * lamejs is kept as a separate LGPL library and loaded only when an MP3
 * conversion is requested. The service worker precaches the script so this
 * remains available offline.
 */

import { ConversionCancelledError } from './conversion.js';
import { floatToPcm16 } from './wav.js';

export const MP3_ENCODER_AVAILABLE = true;
export const MP3_CHUNK_FRAMES = 9_216;

/** @typedef {{ encodeBuffer: (left: Int16Array, right?: Int16Array) => Int8Array, flush: () => Int8Array }} Mp3Encoder */
/** @typedef {new (channels: number, sampleRate: number, bitrateKbps: number) => Mp3Encoder} Mp3EncoderConstructor */
/** @typedef {{ lamejs?: { Mp3Encoder?: Mp3EncoderConstructor } }} Mp3EncoderGlobal */

/** @type {Promise<Mp3EncoderConstructor>|null} */
let encoderConstructorPromise = null;

/** @returns {Promise<Mp3EncoderConstructor>} */
function loadEncoderConstructor() {
  if (encoderConstructorPromise) return encoderConstructorPromise;

  if (typeof document === 'undefined') {
    return Promise.reject(new Error('The local MP3 encoder requires a browser document'));
  }

  encoderConstructorPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = new URL('../../vendor/lamejs-1.2.1/lame.min.js', import.meta.url).href;
    script.onload = () => {
      script.remove();
      const constructor = /** @type {Mp3EncoderGlobal} */ (globalThis).lamejs?.Mp3Encoder;
      if (typeof constructor !== 'function') {
        reject(new Error('The local MP3 encoder did not expose its expected API'));
        return;
      }
      resolve(constructor);
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Could not load the local MP3 encoder'));
    };
    document.head.append(script);
  }).catch((error) => {
    encoderConstructorPromise = null;
    throw error;
  });

  return encoderConstructorPromise;
}

/**
 * Wait for an async dependency without delaying cancellation.
 * The dependency may finish loading in the background, but no encoding work
 * starts after the caller has cancelled.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|null} signal
 * @returns {Promise<T>}
 */
function awaitWithCancellation(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ConversionCancelledError());

  return new Promise((resolve, reject) => {
    const removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
    const handleAbort = () => {
      removeAbortListener();
      reject(new ConversionCancelledError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    promise.then(
      (value) => {
        removeAbortListener();
        resolve(value);
      },
      (error) => {
        removeAbortListener();
        reject(error);
      },
    );
  });
}

/**
 * Validate PCM input before allocating encoder buffers.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} bitrate
 * @returns {{ channelCount: number, frameCount: number }}
 */
function assertAudio(channels, sampleRate, bitrate) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new TypeError('MP3 encoding requires one or two audio channels');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError(`Unsupported MP3 input sample rate: ${sampleRate}`);
  }
  if (!Number.isInteger(bitrate) || bitrate < 8_000 || bitrate > 320_000) {
    throw new RangeError(`Unsupported MP3 bitrate: ${bitrate}`);
  }

  const frameCount = channels[0].length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new TypeError('MP3 channels must be Float32Array instances');
    }
    if (channel.length !== frameCount) {
      throw new TypeError('MP3 channels must have the same number of frames');
    }
  }
  if (frameCount === 0) throw new RangeError('There are no audio frames to encode');

  return { channelCount: channels.length, frameCount };
}

/**
 * Yield so the UI can paint progress and deliver a cancel action.
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Encode PCM channels as an MP3 blob in bounded chunks.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} bitrate
 * @param {{
 *   signal?: AbortSignal|null,
 *   onProgress?: ((fraction: number) => void)|null,
 *   chunkFrames?: number,
 *   yieldFn?: (() => Promise<void>)|null,
 *   createEncoder?: (channels: number, sampleRate: number, bitrateKbps: number) => Mp3Encoder|Promise<Mp3Encoder>,
 * }} [options]
 * @returns {Promise<Blob>}
 */
export async function encodeMp3Async(
  channels,
  sampleRate,
  bitrate,
  {
    signal = null,
    onProgress = null,
    chunkFrames = MP3_CHUNK_FRAMES,
    yieldFn = null,
    createEncoder = async (count, rate, kbps) => {
      const Constructor = await loadEncoderConstructor();
      return new Constructor(count, rate, kbps);
    },
  } = {},
) {
  const { channelCount, frameCount } = assertAudio(channels, sampleRate, bitrate);
  const chunkSize = Math.max(1, Math.floor(Number(chunkFrames) || MP3_CHUNK_FRAMES));
  const yieldNow = yieldFn ?? yieldToEventLoop;

  if (signal?.aborted) throw new ConversionCancelledError();
  if (onProgress) onProgress(0);

  const encoder = await awaitWithCancellation(
    Promise.resolve().then(() => createEncoder(channelCount, sampleRate, bitrate / 1_000)),
    signal,
  );
  if (signal?.aborted) throw new ConversionCancelledError();

  /** @type {Int8Array[]} */
  const output = [];
  let written = 0;
  while (written < frameCount) {
    if (signal?.aborted) throw new ConversionCancelledError();

    const end = Math.min(frameCount, written + chunkSize);
    const left = new Int16Array(end - written);
    const right = channelCount === 2 ? new Int16Array(end - written) : null;
    for (let frame = written; frame < end; frame += 1) {
      const offset = frame - written;
      left[offset] = Math.round(floatToPcm16(channels[0][frame]));
      if (right) right[offset] = Math.round(floatToPcm16(channels[1][frame]));
    }

    const encoded = right ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
    if (encoded?.length) output.push(encoded);
    written = end;
    if (onProgress) onProgress(written / frameCount);
    if (written < frameCount) await yieldNow();
  }

  if (signal?.aborted) throw new ConversionCancelledError();
  const finalBytes = encoder.flush();
  if (finalBytes?.length) output.push(finalBytes);
  const blob = new Blob(output, { type: 'audio/mpeg' });
  if (blob.size === 0) throw new Error('The MP3 encoder produced an empty file');
  return blob;
}
