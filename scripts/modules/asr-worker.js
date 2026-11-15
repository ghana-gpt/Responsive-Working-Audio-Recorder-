/**
 * Whisper inference worker.
 *
 * Runs Transformers.js + ONNX Runtime Web off the main thread so a long decode
 * never freezes the recorder UI. Everything it loads is served from this origin:
 *
 *   models/whisper-tiny/       the quantised ONNX graphs + tokenizer + configs,
 *                              installed by `npm run models:download`
 *   vendor/transformers/       transformers.min.js + ort-wasm-simd.wasm
 *
 * `allowRemoteModels` is off, so a missing local file is a hard error instead of
 * a quiet request to the Hugging Face Hub — the app's offline promise depends on
 * that. The release asset is only fetched by the developer-facing download
 * script, never by this worker, which also means a clone without the model still
 * starts and simply reports that transcription is unavailable.
 */

import { env, pipeline } from '../../vendor/transformers/transformers.min.js';
import {
  ASR_SAMPLE_RATE,
  ASR_WINDOW_SECONDS,
  SILENCE_RMS,
  isModelAvailable,
  mergeWindows,
  planWindows,
  resampleLinear,
  windowRms,
} from './asr.js';

const MODEL_ROOT = new URL('../../models/', import.meta.url).href;
const MODEL_ENTRY = new URL('whisper-tiny/', MODEL_ROOT).href;
const RUNTIME_ROOT = new URL('../../vendor/transformers/', import.meta.url).href;

env.allowRemoteModels = false; // never fetch from a CDN/Hub at runtime
env.allowLocalModels = true;
env.localModelPath = MODEL_ROOT;
env.useBrowserCache = true;
// The wasm binary must come from our own vendor folder: the library default is
// a jsDelivr URL, which would break both offline use and the CSP.
env.backends.onnx.wasm.wasmPaths = RUNTIME_ROOT;
// GitHub Pages cannot send COOP/COEP, so threaded wasm is not available; using
// one thread also means only `ort-wasm-simd.wasm` is needed.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

/** @type {Promise<any>|null} */
let pipelinePromise = null;
/** id of the request the worker should abandon, or null */
let cancelledId = null;

/** Post a message back to the page. */
function post(message) {
  self.postMessage(message);
}

/**
 * Load (once) and return the ASR pipeline.
 * @param {(progress: { stage: string, fraction: number|null }) => void} onProgress
 */
async function loadPipeline(onProgress) {
  if (pipelinePromise) {
    onProgress({ stage: 'load', fraction: 1 });
    return pipelinePromise;
  }

  /** @type {Record<string, number>} */
  const files = {};
  pipelinePromise = pipeline('automatic-speech-recognition', 'whisper-tiny', {
    quantized: true,
    progress_callback: (event) => {
      if (!event || typeof event !== 'object') return;
      if (event.status === 'progress' && event.file) {
        const total = Number(event.total) || 0;
        const loaded = Number(event.loaded) || 0;
        files[event.file] = total > 0 ? Math.min(1, loaded / total) : 0;
        const values = Object.values(files);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        onProgress({ stage: 'load', fraction: average });
      }
    },
  }).catch((error) => {
    // A failed load must not be cached forever: the next attempt may succeed
    // (for example after the browser finishes precaching the model files).
    pipelinePromise = null;
    throw error;
  });

  return pipelinePromise;
}

/** Convert a pipeline output into `{ start, end, text }` segments. */
function toSegments(output, windowSeconds) {
  const chunks = Array.isArray(output?.chunks) ? output.chunks : [];
  const segments = [];
  for (const chunk of chunks) {
    const text = String(chunk?.text ?? '').trim();
    if (!text) continue;
    const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
    const from = Number.isFinite(Number(start)) ? Number(start) : 0;
    const to = Number.isFinite(Number(end)) ? Number(end) : windowSeconds;
    segments.push({ start: Math.max(0, from), end: Math.max(from, to), text });
  }
  if (segments.length === 0) {
    const text = String(output?.text ?? '').trim();
    if (text) segments.push({ start: 0, end: windowSeconds, text });
  }
  return segments;
}

/**
 * Decode every 30 s window in order and report progress between windows.
 *
 * @param {number} id request id
 * @param {{ samples: Float32Array, sampleRate: number, language: string, windowSeconds: number }} request
 */
async function runTranscription(id, request) {
  const asr = await loadPipeline((progress) => {
    if (cancelledId === id) return;
    post({ type: 'progress', id, ...progress });
  });
  if (cancelledId === id) {
    post({ type: 'cancelled', id });
    return;
  }
  // Some files report no `total`, so the averaged progress can stop short of 1;
  // say "loaded" explicitly once the pipeline is really ready.
  post({ type: 'progress', id, stage: 'load', fraction: 1 });

  const sourceRate = Number(request.sampleRate) || ASR_SAMPLE_RATE;
  const source = request.samples instanceof Float32Array ? request.samples : new Float32Array(0);
  const mono =
    sourceRate === ASR_SAMPLE_RATE ? source : resampleLinear(source, sourceRate, ASR_SAMPLE_RATE);
  const windows = planWindows(mono.length, {
    sampleRate: ASR_SAMPLE_RATE,
    windowSeconds: Number(request.windowSeconds) || ASR_WINDOW_SECONDS,
  });

  const results = [];
  let skippedWindows = 0;

  for (const [index, window] of windows.entries()) {
    if (cancelledId === id) {
      post({ type: 'cancelled', id });
      return;
    }

    const chunk = mono.subarray(window.startSample, window.endSample);
    const seconds = (window.endSample - window.startSample) / ASR_SAMPLE_RATE;

    if (windowRms(chunk) < SILENCE_RMS) {
      // Whisper invents phrases for silence; skip those windows instead of
      // storing a hallucination.
      skippedWindows += 1;
      results.push({ startSeconds: window.startSeconds, text: '', segments: [] });
    } else {
      const options = { return_timestamps: true, task: 'transcribe' };
      if (request.language && request.language !== 'auto') options.language = request.language;
      const output = await asr(chunk, options);
      results.push({
        startSeconds: window.startSeconds,
        text: output?.text ?? '',
        segments: toSegments(output, seconds),
      });
    }

    post({
      type: 'progress',
      id,
      stage: 'transcribe',
      fraction: (index + 1) / windows.length,
    });
  }

  if (cancelledId === id) {
    post({ type: 'cancelled', id });
    return;
  }

  const merged = mergeWindows(results);
  post({
    type: 'result',
    id,
    ...merged,
    language: request.language || 'auto',
    skippedWindows,
    durationSeconds: mono.length / ASR_SAMPLE_RATE,
  });
}

self.addEventListener('message', async (event) => {
  const data = event.data ?? {};
  if (data.type === 'cancel') {
    cancelledId = data.id;
    return;
  }
  if (data.type !== 'transcribe') return;

  cancelledId = null;
  try {
    await runTranscription(data.id, data);
  } catch (error) {
    console.error('[asr-worker] failed', error);
    // Distinguish "this browser cannot decode" from "the files were never
    // installed": the UI can only tell the user what to do in the second case.
    const code = (await isModelAvailable(MODEL_ENTRY)) ? 'asrFailed' : 'modelMissing';
    post({
      type: 'error',
      id: data.id,
      code,
      message: String(error?.message ?? error ?? 'Transcription failed'),
    });
  }
});
