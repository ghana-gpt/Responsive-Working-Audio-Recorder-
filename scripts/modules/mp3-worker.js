/**
 * Module worker that owns the WebAssembly MP3 encoder.
 *
 * Encoding a minute of audio takes a few seconds of solid computation, and the
 * WASM call cannot be sliced or interrupted, so the work happens here: the page
 * stays responsive, progress messages keep arriving, and cancelling simply
 * terminates this worker (`mp3.js`).
 *
 * Protocol — one `encode` request per worker lifetime, though extra requests are
 * queued in order rather than interleaved, because the bridge keeps a single
 * input/output buffer:
 *
 *   → { type: 'encode', id, planes: Float32Array[], sampleRate, bitrateKbps }
 *   ← { type: 'progress', id, fraction: number|null }
 *   ← { type: 'done', id, bytes: Uint8Array }   (transferred)
 *   ← { type: 'error', id, message }
 *
 * The binary is fetched here, not by the page, so an install that never exports
 * MP3 never downloads the encoder.
 */

import { Mp3WasmEncoder, loadMp3Wasm } from './mp3-wasm.js';

/** @type {Promise<Mp3WasmEncoder>|null} */
let encoderPromise = null;

/**
 * Load the encoder once per worker, and forget the promise on failure so the
 * next request retries instead of replaying a cached rejection.
 *
 * @returns {Promise<Mp3WasmEncoder>}
 */
function getEncoder() {
  if (!encoderPromise) {
    encoderPromise = loadMp3Wasm()
      .then((exports) => new Mp3WasmEncoder(exports))
      .catch((error) => {
        encoderPromise = null;
        throw error;
      });
  }
  return encoderPromise;
}

/**
 * @param {{ id: number, planes: Float32Array[], sampleRate: number, bitrateKbps: number }} request
 * @returns {Promise<void>}
 */
async function handleEncode({ id, planes, sampleRate, bitrateKbps }) {
  try {
    const encoder = await getEncoder();
    const bytes = await encoder.encode(planes, {
      sampleRate,
      bitrateKbps,
      onProgress: (fraction) => self.postMessage({ id, type: 'progress', fraction }),
    });
    self.postMessage({ id, type: 'done', bytes }, [bytes.buffer]);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    self.postMessage({ id, type: 'error', message });
  }
}

/** Requests are handled one at a time, in arrival order. */
let queue = Promise.resolve();

self.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || request.type !== 'encode') return;
  queue = queue.then(() => handleEncode(request));
});
