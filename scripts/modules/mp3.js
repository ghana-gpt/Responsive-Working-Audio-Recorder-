/**
 * Same-origin MP3 encoder adapter.
 *
 * The encoder is a WebAssembly build of the vendored audiobox MPEG-1 Layer III
 * encoder (MIT — see `vendor/audiobox/NOTICE.md`). It runs in a dedicated module
 * worker (see `mp3-worker.js`), which also fetches the binary, so nothing about
 * MP3 is downloaded, compiled or executed until a conversion actually asks for
 * it. The service worker precaches both files, so all of this works offline.
 *
 * The conversion contract is the one every other conversion follows
 * (`conversion.js`): progress is reported for as long as it is known, a
 * cancellation stops the work promptly, and failures reject with a readable
 * reason. Because the WASM call is a single uninterruptible step, cancelling
 * terminates the worker — the only way to stop it — and progress is reported as
 * `null` (unknown) while that call runs, exactly like decoding.
 *
 * Nothing here touches the DOM, so `tests/unit/mp3.test.js` drives it in Node
 * with a fake encoder.
 */

import { ConversionCancelledError } from './conversion.js';

/** Always true: the encoder ships with the app and needs no browser feature. */
export const MP3_ENCODER_AVAILABLE = true;

/** Sample rates MPEG-1 Layer III supports (and the encoder writes). */
export const MP3_SAMPLE_RATES = Object.freeze([32_000, 44_100, 48_000]);

/** CBR bitrates the encoder accepts, in bit/s (the MPEG-1 table). */
export const MP3_BITRATES = Object.freeze([
  32_000, 40_000, 48_000, 56_000, 64_000, 80_000, 96_000, 112_000, 128_000, 160_000, 192_000,
  224_000, 256_000, 320_000,
]);

/**
 * Client side of `mp3-worker.js`.
 *
 * One worker per conversion, terminated when the conversion ends — finished,
 * failed or cancelled. That also returns every byte of heap the encoder used,
 * which matters after exporting a long capture.
 */
class WorkerMp3Encoder {
  constructor() {
    if (typeof Worker !== 'function') {
      throw new Error('This browser cannot run the local MP3 encoder');
    }
    this.worker = new Worker(new URL('./mp3-worker.js', import.meta.url), { type: 'module' });
    /** @type {Map<number, { resolve: (bytes: Uint8Array) => void, reject: (error: Error) => void, onProgress: ((fraction: number|null) => void)|null }>} */
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      // A module that fails to load (offline, CSP, syntax error) arrives here
      // without a request id, so every waiter has to be failed.
      this.rejectAll(new Error(event?.message || 'The local MP3 encoder could not start'));
    });
  }

  /**
   * @param {Float32Array[]} planes
   * @param {{
   *   sampleRate: number,
   *   bitrateKbps: number,
   *   onProgress?: ((fraction: number|null) => void)|null,
   * }} options
   * @returns {Promise<Uint8Array>}
   */
  encode(planes, { sampleRate, bitrateKbps, onProgress = null } = {}) {
    if (this.closed) return Promise.reject(new Error('The MP3 encoder has been closed'));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type: 'encode', planes, sampleRate, bitrateKbps });
    });
  }

  /**
   * @param {{ id?: number, type?: string, fraction?: number|null, bytes?: Uint8Array, message?: string }} data
   */
  handleMessage(data) {
    const entry = data && typeof data.id === 'number' ? this.pending.get(data.id) : undefined;
    if (!entry) return;

    if (data.type === 'progress') {
      if (entry.onProgress) entry.onProgress(data.fraction ?? null);
      return;
    }

    this.pending.delete(data.id);
    if (data.type === 'done') {
      const bytes =
        data.bytes instanceof Uint8Array ? data.bytes : new Uint8Array(data.bytes ?? []);
      entry.resolve(bytes);
      return;
    }
    entry.reject(new Error(data.message || 'The local MP3 encoder failed'));
  }

  /** @param {Error} error */
  rejectAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  /** Terminate the worker. Safe to call twice, and after a successful encode. */
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.rejectAll(new Error('The MP3 encoder was closed before it finished'));
  }
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
 * Validate PCM input before a worker is started or a buffer is allocated.
 *
 * Rejects anything MPEG-1 Layer III cannot represent, so the user sees a precise
 * reason instead of a failure from deep inside the encoder.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} bitrate
 * @returns {{ channelCount: number, frameCount: number }}
 */
function assertAudio(channels, sampleRate, bitrate) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new TypeError('MP3 export needs one or two audio channels');
  }
  if (!MP3_SAMPLE_RATES.includes(sampleRate)) {
    throw new RangeError(
      `MP3 cannot store ${sampleRate} Hz; the supported rates are ${MP3_SAMPLE_RATES.join(', ')} Hz`,
    );
  }
  if (!MP3_BITRATES.includes(bitrate)) {
    throw new RangeError(
      `Unsupported MP3 bitrate: ${bitrate}; the supported rates are ${MP3_BITRATES.join(', ')} bit/s`,
    );
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
 * Encode PCM channels as an MP3 blob.
 *
 * Progress is `0` once the encoder is ready, then a fraction while the samples
 * are copied into the WASM heap, then `null` for the duration of the encode
 * (the encoder cannot report inside a single call), then `1`.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} bitrate in bit/s
 * @param {{
 *   signal?: AbortSignal|null,
 *   onProgress?: ((fraction: number|null) => void)|null,
 *   createEncoder?: () => Promise<{ encode: (planes: Float32Array[], options: object) => Promise<Uint8Array>, dispose?: () => void }>|{ encode: (planes: Float32Array[], options: object) => Promise<Uint8Array>, dispose?: () => void },
 * }} [options]
 * @returns {Promise<Blob>}
 */
export async function encodeMp3Async(
  channels,
  sampleRate,
  bitrate,
  { signal = null, onProgress = null, createEncoder = () => new WorkerMp3Encoder() } = {},
) {
  assertAudio(channels, sampleRate, bitrate);
  if (signal?.aborted) throw new ConversionCancelledError();
  if (onProgress) onProgress(0);

  const encoder = await awaitWithCancellation(Promise.resolve().then(createEncoder), signal);

  // Aborting cannot interrupt the WASM call, so the worker is terminated instead
  // of being asked to stop: no work outlives the request.
  const handleAbort = () => encoder.dispose?.();
  if (signal) signal.addEventListener('abort', handleAbort, { once: true });

  try {
    if (signal?.aborted) throw new ConversionCancelledError();

    let bytes;
    try {
      // A terminated worker never settles the request, so the wait has to end
      // with the abort rather than with the worker.
      bytes = await awaitWithCancellation(
        encoder.encode(channels, {
          sampleRate,
          bitrateKbps: bitrate / 1_000,
          onProgress: (fraction) => {
            if (signal?.aborted || !onProgress) return;
            onProgress(fraction);
          },
        }),
        signal,
      );
    } catch (error) {
      // A terminated worker rejects with its own message; the caller's intent wins.
      if (signal?.aborted) throw new ConversionCancelledError();
      throw error;
    }

    if (signal?.aborted) throw new ConversionCancelledError();
    if (!bytes || bytes.length === 0) throw new Error('The MP3 encoder produced an empty file');
    if (onProgress) onProgress(1);
    return new Blob([bytes], { type: 'audio/mpeg' });
  } finally {
    if (signal) signal.removeEventListener('abort', handleAbort);
    encoder.dispose?.();
  }
}
