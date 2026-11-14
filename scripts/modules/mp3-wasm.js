/**
 * The WebAssembly MP3 encoder: loading the binary and driving its C ABI.
 *
 * The actual encoding lives in Rust (`encoder/`, wrapping the vendored
 * `audiobox` 0.5.1 crate — MIT, see `vendor/audiobox/NOTICE.md`); this module is
 * the only place that knows the pointer dance. It is imported by the module
 * worker (`mp3-worker.js`) and never runs on the page's main thread: a single
 * encode call blocks for its whole duration, which would freeze the recorder.
 *
 * ABI reminder (see `encoder/src/lib.rs`): every exported call may grow the WASM
 * heap and detach the typed-array views created before it, so views are always
 * re-created right before they are used and never cached.
 */

/** The committed binary, resolved relative to this module. */
export const MP3_WASM_URL = new URL('../../vendor/audiobox/mp3-encoder.wasm', import.meta.url).href;

/**
 * Samples copied into the WASM heap between yields. 2^18 f32 values is 1 MiB, so
 * even an hour-long capture is copied in slices short enough that a stop request
 * still lands promptly.
 */
export const COPY_SLICE_SAMPLES = 1 << 18;

/** Everything the bridge must export before the app may use it. */
export const REQUIRED_EXPORTS = Object.freeze([
  'memory',
  'abx_input',
  'abx_encode',
  'abx_output_ptr',
  'abx_output_len',
  'abx_error_ptr',
  'abx_error_len',
]);

/**
 * @param {WebAssembly.Exports|undefined} exports
 * @returns {WebAssembly.Exports}
 */
export function assertMp3Exports(exports) {
  if (!exports || typeof exports !== 'object') {
    throw new Error('The MP3 encoder module exposes nothing');
  }
  const missing = REQUIRED_EXPORTS.filter((name) => {
    const value = exports[name];
    return name === 'memory' ? !(value instanceof WebAssembly.Memory) : typeof value !== 'function';
  });
  if (missing.length > 0) {
    throw new Error(`The MP3 encoder module is missing “${missing.join('”, “')}”`);
  }
  return exports;
}

/**
 * Instantiate the bridge from its bytes.
 *
 * `WebAssembly.instantiate(bytes)` is used instead of the streaming variant on
 * purpose: the latter needs an `application/wasm` response, and a misconfigured
 * static host would turn a working install into a confusing MIME-type error.
 *
 * @param {BufferSource} bytes
 * @returns {Promise<WebAssembly.Exports>}
 */
export async function instantiateMp3Wasm(bytes) {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return assertMp3Exports(instance.exports);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The MP3 encoder could not be instantiated: ${message}`, { cause: error });
  }
}

/**
 * Fetch and instantiate the committed binary.
 *
 * @param {{ url?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<WebAssembly.Exports>}
 */
export async function loadMp3Wasm({ url = MP3_WASM_URL, fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('The MP3 encoder needs fetch to load');
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Could not load the MP3 encoder (HTTP ${response.status})`);
  return instantiateMp3Wasm(await response.arrayBuffer());
}

/**
 * Read the bridge's last error message.
 *
 * @param {WebAssembly.Exports} exports
 * @param {string} fallback
 * @returns {Error}
 */
function readError(exports, fallback) {
  const length = Number(exports.abx_error_len());
  if (length > 0) {
    const bytes = new Uint8Array(exports.memory.buffer, Number(exports.abx_error_ptr()), length);
    const message = new TextDecoder().decode(bytes).trim();
    if (message) return new Error(message);
  }
  return new Error(fallback);
}

/**
 * Yield to the event loop so the worker can deliver queued messages.
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One instantiated bridge, reusable for several encodes. */
export class Mp3WasmEncoder {
  /**
   * @param {WebAssembly.Exports} exports
   */
  constructor(exports) {
    this.exports = assertMp3Exports(exports);
    this.disposed = false;
  }

  /**
   * Encode planar float samples as an MP3 file.
   *
   * Progress is reported as `0…1` while the samples are copied into the WASM
   * heap, then as `null` (unknown) while the encoder runs: the Rust call is a
   * single opaque step, so claiming a percentage there would be a lie.
   *
   * @param {Float32Array[]} planes one array per channel, all the same length
   * @param {{
   *   sampleRate: number,
   *   bitrateKbps: number,
   *   onProgress?: ((fraction: number|null) => void)|null,
   *   yieldFn?: (() => Promise<void>)|null,
   * }} options
   * @returns {Promise<Uint8Array>}
   */
  async encode(
    planes,
    { sampleRate, bitrateKbps, onProgress = null, yieldFn = yieldToEventLoop } = {},
  ) {
    if (this.disposed) throw new Error('The MP3 encoder has been closed');
    if (!Array.isArray(planes) || planes.length < 1 || planes.length > 2) {
      throw new TypeError('MP3 needs one or two channels');
    }
    const channelCount = planes.length;
    const frameCount = planes[0].length;
    const total = frameCount * channelCount;
    if (frameCount === 0) throw new RangeError('There are no audio frames to encode');

    const address = Number(this.exports.abx_input(total));
    if (!address) throw readError(this.exports, 'The MP3 encoder could not allocate its buffer');

    // One view for the whole copy: `abx_input` has already grown the heap and
    // nothing else can grow it until `abx_encode` is called.
    const heap = new Float32Array(this.exports.memory.buffer, address, total);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const plane = planes[channel];
      const base = channel * frameCount;
      for (let start = 0; start < frameCount; start += COPY_SLICE_SAMPLES) {
        const end = Math.min(frameCount, start + COPY_SLICE_SAMPLES);
        heap.set(plane.subarray(start, end), base + start);
        if (end < frameCount) await yieldFn();
      }
      if (onProgress) onProgress((channel + 1) / channelCount);
    }

    // Let the "unknown progress" report reach the page before blocking.
    if (onProgress) onProgress(null);
    await yieldFn();

    // The bridge takes the bitrate in kbit/s, like the MPEG header it writes.
    const encoded = Number(
      this.exports.abx_encode(frameCount, channelCount, sampleRate, bitrateKbps),
    );
    if (!encoded) throw readError(this.exports, 'The MP3 encoder failed');

    const length = Number(this.exports.abx_output_len());
    if (length === 0) throw readError(this.exports, 'The MP3 encoder produced no bytes');
    const pointer = Number(this.exports.abx_output_ptr());
    return new Uint8Array(this.exports.memory.buffer, pointer, length).slice();
  }

  /** Release the instance. The bridge owns no handles, so this only refuses later calls. */
  dispose() {
    this.disposed = true;
  }
}
