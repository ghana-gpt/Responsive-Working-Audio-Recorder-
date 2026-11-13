/**
 * On-device speech transcription.
 *
 * Whisper (the multilingual `tiny` checkpoint, quantised) runs in a dedicated
 * Web Worker through Transformers.js and ONNX Runtime Web. Nothing is uploaded
 * and nothing is fetched from a CDN: the model files live in `models/` next to
 * the app and the ONNX runtime WASM binary lives in `vendor/transformers/`.
 *
 * This module holds the parts that are pure data manipulation (resampling,
 * window planning, timestamp formatting, merging) so they can be unit tested in
 * Node, plus the main-thread client for the worker. The worker itself is
 * `asr-worker.js`; it shares the same helpers.
 */

/** Whisper always expects 16 kHz mono float samples. */
export const ASR_SAMPLE_RATE = 16000;

/**
 * Whisper's receptive field is 30 s. Windows are decoded one at a time with
 * `return_timestamps: true`; the pipeline's own `chunk_length_s` path is not
 * used because it drops the audio when combined with `stride_length_s` in
 * Transformers.js 2.17 (verified against the real model — see RELEASES.md).
 */
export const ASR_WINDOW_SECONDS = 30;

/** Folder name inside `models/` (also the model id passed to the pipeline). */
export const ASR_MODEL_ID = 'whisper-tiny';

/** Human readable description shown in the transcript meta line. */
export const ASR_MODEL_LABEL = 'Whisper tiny · multilingual · q8';

/** Languages the UI offers; `auto` lets Whisper detect the spoken language. */
export const ASR_LANGUAGES = Object.freeze([
  { id: 'auto', labelKey: 'asr.languageAuto' },
  { id: 'en', labelKey: 'asr.languageEn' },
  { id: 'fr', labelKey: 'asr.languageFr' },
]);

/**
 * Bytes of every file under `models/whisper-tiny/` (configs + both ONNX
 * graphs). Kept in one place so the UI can state the real download/storage cost
 * and `tests/unit/asr.test.js` can assert the number against the files on disk.
 */
export const ASR_MODEL_BYTES = 45_209_522;

/** Below this RMS a window is treated as silence (Whisper hallucinates on it). */
export const SILENCE_RMS = 0.0015;

/** Hard cap so a corrupted pipeline result can never bloat IndexedDB. */
export const MAX_TRANSCRIPT_CHARS = 500_000;

/** Error with a stable `code` the UI maps to a localised message. */
export class AsrError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message ?? code);
    this.name = 'AsrError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* DSP helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Linear resampling. Whisper is trained on 16 kHz audio, but a microphone
 * capture is typically 44.1/48 kHz.
 *
 * `decodeAudioData` cannot resample on demand, and `OfflineAudioContext` would
 * allocate a second copy of the whole recording, so a simple interpolator keeps
 * memory flat and is accurate enough for speech.
 *
 * @param {Float32Array|number[]} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleLinear(input, fromRate, toRate) {
  const samples = input instanceof Float32Array ? input : Float32Array.from(input ?? []);
  const sourceRate = Number(fromRate);
  const targetRate = Number(toRate);
  if (samples.length === 0) return new Float32Array(0);
  if (!(sourceRate > 0) || !(targetRate > 0) || sourceRate === targetRate) {
    return samples;
  }

  const ratio = targetRate / sourceRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(length);
  const lastIndex = samples.length - 1;
  for (let index = 0; index < length; index += 1) {
    const position = index / ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lastIndex, lower + 1);
    const weight = position - lower;
    const a = samples[Math.min(lastIndex, lower)] ?? 0;
    const b = samples[upper] ?? a;
    output[index] = a * (1 - weight) + b * weight;
  }
  return output;
}

/**
 * Average every channel into one mono track (Whisper is mono-only).
 *
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function downmixToMono(channels) {
  const list = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number' && channel.length > 0,
  );
  if (list.length === 0) return new Float32Array(0);
  if (list.length === 1) return Float32Array.from(list[0]);

  const length = Math.max(...list.map((channel) => channel.length));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of list) sum += channel[index] ?? 0;
    output[index] = sum / list.length;
  }
  return output;
}

/**
 * Root-mean-square level of a block of samples (0 = digital silence).
 *
 * @param {Float32Array|number[]} samples
 * @returns {number}
 */
export function windowRms(samples) {
  const list = samples ?? [];
  if (!list.length) return 0;
  let sum = 0;
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / list.length);
}

/**
 * Split the audio into Whisper-sized, non-overlapping windows.
 *
 * Overlapping windows would need text de-duplication at the seams, which
 * Whisper tiny cannot do reliably; cutting on a fixed 30 s boundary and
 * concatenating the segments is predictable and keeps timestamps exact.
 *
 * @param {number} totalSamples
 * @param {{ sampleRate?: number, windowSeconds?: number }} [options]
 * @returns {Array<{ startSample: number, endSample: number, startSeconds: number }>}
 */
export function planWindows(
  totalSamples,
  { sampleRate = ASR_SAMPLE_RATE, windowSeconds = ASR_WINDOW_SECONDS } = {},
) {
  const total = Math.max(0, Math.floor(Number(totalSamples) || 0));
  const rate = Number(sampleRate);
  if (total === 0 || !(rate > 0)) return [];

  const size = Math.max(1, Math.round(Number(windowSeconds) * rate));
  const windows = [];
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    windows.push({ startSample: start, endSample: end, startSeconds: start / rate });
  }
  return windows;
}

/**
 * Normalise a segment list: finite numbers only, empty text dropped, sorted by
 * start time and with `end` never before `start`.
 *
 * @param {Array<{ start?: number, end?: number, text?: string }>} segments
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
export function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const output = [];
  for (const segment of list) {
    const text = String(segment?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
    const safeEnd = Number.isFinite(end) ? Math.max(safeStart, end) : safeStart;
    output.push({ start: safeStart, end: safeEnd, text });
  }
  return output.sort((a, b) => a.start - b.start);
}

/**
 * Turn the per-window results into one transcript: window offsets are added to
 * every timestamp and the text is concatenated in order.
 *
 * @param {Array<{ startSeconds: number, text?: string, segments?: object[] }>} windows
 * @returns {{ text: string, segments: Array<{ start: number, end: number, text: string }> }}
 */
export function mergeWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  const segments = [];
  const texts = [];

  for (const window of list) {
    const offset = Math.max(0, Number(window?.startSeconds) || 0);
    const text = String(window?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) texts.push(text);
    for (const segment of normalizeSegments(window?.segments)) {
      segments.push({
        start: segment.start + offset,
        end: segment.end + offset,
        text: segment.text,
      });
    }
  }

  return {
    text: texts.join(' ').replace(/\s+/g, ' ').trim(),
    segments: normalizeSegments(segments),
  };
}

/**
 * `HH:MM:SS,mmm` (SubRip) or `HH:MM:SS.mmm` (WebVTT) timestamp.
 *
 * @param {number} seconds
 * @param {{ separator?: string }} [options]
 * @returns {string}
 */
export function formatTimestamp(seconds, { separator = ',' } = {}) {
  const total = Math.max(0, Number(seconds) || 0);
  const milliseconds = Math.round(total * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

/**
 * Render segments as SubRip subtitles.
 *
 * @param {Array<{ start?: number, end?: number, text?: string }>} segments
 * @returns {string} empty string when there is nothing to export
 */
export function formatSrt(segments) {
  const list = normalizeSegments(segments);
  if (list.length === 0) return '';
  const blocks = list.map((segment, index) => {
    const start = formatTimestamp(segment.start);
    const end = formatTimestamp(segment.end);
    return `${index + 1}\n${start} --> ${end}\n${segment.text}`;
  });
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Plain-text rendering of a transcript.
 *
 * @param {{ text?: string, segments?: object[] }|null} transcript
 * @returns {string}
 */
export function formatTranscriptText(transcript) {
  const stored = String(transcript?.text ?? '').trim();
  if (stored) return stored;
  return normalizeSegments(transcript?.segments)
    .map((segment) => segment.text)
    .join(' ')
    .trim();
}

/**
 * Shape a worker result into the object persisted on the recording.
 *
 * @param {{ text?: string, segments?: object[], language?: string, skippedWindows?: number }} result
 * @param {{ model?: string, createdAt?: number, durationSeconds?: number }} [meta]
 * @returns {{
 *   text: string,
 *   segments: Array<{ start: number, end: number, text: string }>,
 *   language: string,
 *   model: string,
 *   createdAt: number,
 *   durationSeconds: number,
 *   skippedWindows: number,
 * }|null} `null` when nothing was recognised
 */
export function buildTranscript(
  result,
  { model = ASR_MODEL_LABEL, createdAt, durationSeconds = 0 } = {},
) {
  const text = String(result?.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const segments = normalizeSegments(result?.segments);
  if (!text) return null;
  return {
    text: text.slice(0, MAX_TRANSCRIPT_CHARS),
    segments,
    language: String(result?.language ?? 'auto'),
    model: String(model),
    createdAt: Number(createdAt) || 0,
    durationSeconds: Math.max(0, Number(durationSeconds) || 0),
    skippedWindows: Math.max(0, Math.floor(Number(result?.skippedWindows) || 0)),
  };
}

/* -------------------------------------------------------------------------- */
/* Worker client                                                              */
/* -------------------------------------------------------------------------- */

/** @returns {boolean} whether this browser can run the model at all */
export function isAsrSupported() {
  try {
    return typeof Worker === 'function' && typeof WebAssembly === 'object';
  } catch {
    return false;
  }
}

/** Default worker: a module worker so it can `import` the vendored runtime. */
function defaultWorkerFactory() {
  return new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
}

/**
 * Main-thread client for the transcription worker.
 *
 * Only one transcription runs at a time: the model holds a single ONNX session
 * and the app shows one progress bar. A second call rejects with `busy` instead
 * of queueing work the user cannot see.
 *
 * @param {{ workerFactory?: () => Worker }} [options]
 */
export function createTranscriber({ workerFactory = defaultWorkerFactory } = {}) {
  /** @type {Worker|null} */
  let worker = null;
  /** @type {{ id: number, resolve: Function, reject: Function, onProgress?: Function, signal?: AbortSignal|null, abortListener?: Function }|null} */
  let pending = null;
  let sequence = 0;

  function settlePending() {
    const current = pending;
    pending = null;
    return current;
  }

  function fail(code, message) {
    const current = settlePending();
    if (!current) return;
    if (current.signal && current.abortListener) {
      current.signal.removeEventListener('abort', current.abortListener);
    }
    current.reject(new AsrError(code, message));
  }

  function handleMessage(event) {
    const data = event.data ?? {};
    const current = pending;
    if (!current || data.id !== current.id) return;

    if (data.type === 'progress') {
      // `null` means "the model is loading, there is no fraction yet": Number(null)
      // would turn that into 0 and render a bar that looks stalled at the start.
      const fraction =
        data.fraction === null || data.fraction === undefined ? null : Number(data.fraction);
      try {
        current.onProgress?.({
          stage: data.stage === 'load' ? 'load' : 'transcribe',
          fraction: Number.isFinite(fraction) ? fraction : null,
          detail: data.detail ?? '',
        });
      } catch (error) {
        console.error('[asr] progress handler failed', error);
      }
      return;
    }

    if (data.type === 'result') {
      settlePending();
      if (current.signal && current.abortListener) {
        current.signal.removeEventListener('abort', current.abortListener);
      }
      current.resolve(data);
      return;
    }

    if (data.type === 'cancelled') {
      fail('cancelled', 'Transcription cancelled');
      return;
    }

    if (data.type === 'error') {
      fail(String(data.code ?? 'asrFailed'), String(data.message ?? 'Transcription failed'));
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = workerFactory();
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', (event) => {
      // A worker that fails to boot (CSP, missing file, wasm) never answers a
      // request, so surface it instead of leaving the promise pending forever.
      console.error('[asr] worker error', event?.message ?? event);
      fail('asrFailed', String(event?.message ?? 'Transcription worker crashed'));
    });
    return worker;
  }

  /**
   * Transcribe mono float samples.
   *
   * @param {Float32Array} samples
   * @param {{
   *   sampleRate: number,
   *   language?: string,
   *   signal?: AbortSignal|null,
   *   onProgress?: (progress: { stage: string, fraction: number|null }) => void,
   * }} options
   * @returns {Promise<{ text: string, segments: object[], language: string, skippedWindows: number, durationSeconds: number }>}
   */
  function transcribe(samples, { sampleRate, language = 'auto', signal = null, onProgress } = {}) {
    if (pending) {
      return Promise.reject(new AsrError('busy', 'A transcription is already running'));
    }
    const pcm = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
    if (pcm.length === 0) {
      return Promise.reject(new AsrError('emptyAudio', 'There is no audio to transcribe'));
    }

    sequence += 1;
    const id = sequence;
    const activeWorker = ensureWorker();

    return new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, onProgress, signal, abortListener: null };
      pending = entry;

      if (signal) {
        entry.abortListener = () => {
          if (!pending || pending.id !== id) return;
          activeWorker.postMessage({ type: 'cancel', id });
          // The worker stops between windows; the promise settles right away so
          // the UI cannot get stuck behind a long decode.
          fail('cancelled', 'Transcription cancelled');
        };
        if (signal.aborted) {
          entry.abortListener();
          return;
        }
        signal.addEventListener('abort', entry.abortListener, { once: true });
      }

      // The samples are copied into the worker and never touched here again;
      // a view of a larger buffer is copied first so transferring it cannot
      // detach data the caller still owns (the live tap reuses its slices).
      const payload =
        pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm : pcm.slice();
      activeWorker.postMessage(
        {
          type: 'transcribe',
          id,
          samples: payload,
          sampleRate: Number(sampleRate) || ASR_SAMPLE_RATE,
          language: String(language || 'auto'),
          windowSeconds: ASR_WINDOW_SECONDS,
        },
        [payload.buffer],
      );
    });
  }

  return {
    transcribe,
    isBusy: () => Boolean(pending),
    /** Stop the worker (page unload, tests). */
    dispose: () => {
      fail('cancelled', 'Transcription cancelled');
      worker?.terminate();
      worker = null;
    },
  };
}
