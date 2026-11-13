/**
 * MediaRecorder + Web Audio engine.
 *
 * Responsibilities the original script got wrong and that live here now:
 *  - the microphone stream is always stopped (tracks stopped, context closed)
 *    when recording ends, is cancelled, or the page unloads;
 *  - the container MIME type comes from capability detection, never hard-coded;
 *  - recording duration excludes paused time;
 *  - a rAF loop reports input level + elapsed time for the timer and meter.
 */

import { clamp } from './sanitize.js';

/** Error with a stable `code` that the UI maps to a localised message. */
export class RecorderError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message ?? code);
    this.name = 'RecorderError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const MEDIA_ERROR_CODES = {
  NotAllowedError: 'micDenied',
  PermissionDeniedError: 'micDenied',
  SecurityError: 'micDenied',
  NotFoundError: 'micNotFound',
  DevicesNotFoundError: 'micNotFound',
  OverconstrainedError: 'micNotFound',
  ConstraintNotSatisfiedError: 'micNotFound',
  NotReadableError: 'micInUse',
  TrackStartError: 'micInUse',
  AbortError: 'micInUse',
};

/**
 * Translate a getUserMedia DOMException into an i18n error code.
 * @param {unknown} error
 * @returns {string}
 */
export function mapMediaError(error) {
  const name = /** @type {any} */ (error)?.name;
  return MEDIA_ERROR_CODES[name] ?? 'recordFailed';
}

/** @returns {boolean} */
export function isRecordingSupported() {
  try {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function'
    );
  } catch {
    return false;
  }
}

/** @returns {boolean} */
export function hasSecureContext() {
  try {
    return globalThis.isSecureContext !== false;
  } catch {
    return true;
  }
}

/**
 * Build getUserMedia audio constraints from the user's preferences.
 *
 * @param {{ noiseSuppression?: boolean, echoCancellation?: boolean, autoGainControl?: boolean }} prefs
 * @returns {MediaTrackConstraints}
 */
export function buildAudioConstraints(prefs = {}) {
  return {
    echoCancellation: Boolean(prefs.echoCancellation),
    noiseSuppression: Boolean(prefs.noiseSuppression),
    autoGainControl: Boolean(prefs.autoGainControl),
    channelCount: 1,
  };
}

/**
 * Create a recorder instance. The instance is reusable: `start()` may be called
 * again after `stop()` or `cancel()`.
 *
 * @param {{
 *   onLevel?: (info: { level: number, rms: number, peak: number, db: number }) => void,
 *   onTick?: (elapsedMs: number) => void,
 *   onTrackEnded?: () => void,
 *   onAudio?: (samples: Float32Array, sampleRate: number) => void,
 * }} [handlers]
 */
export function createRecorder({ onLevel, onTick, onTrackEnded, onAudio } = {}) {
  /** @type {MediaStream|null} */ let stream = null;
  /** @type {MediaRecorder|null} */ let mediaRecorder = null;
  /** @type {AudioContext|null} */ let audioContext = null;
  /** @type {AnalyserNode|null} */ let analyser = null;
  /** @type {AudioNode|null} */ let tapSource = null;
  /** @type {ScriptProcessorNode|null} */ let tapNode = null;
  /** @type {GainNode|null} */ let tapSink = null;
  /** @type {number|null} */ let frameRequest = null;
  /** @type {Uint8Array<ArrayBuffer>|null} */ let timeDomainData = null;
  /** @type {Blob[]} */ let chunks = [];
  let startedAt = 0;
  let elapsedBefore = 0;
  let active = false;
  let paused = false;
  let stopping = false;

  const emitLevel = (info) => {
    try {
      onLevel?.(info);
    } catch (error) {
      console.error('[recorder] onLevel failed', error);
    }
  };
  const emitTick = (elapsed) => {
    try {
      onTick?.(elapsed);
    } catch (error) {
      console.error('[recorder] onTick failed', error);
    }
  };

  /** Elapsed recording time in ms, excluding paused intervals. */
  function getElapsed() {
    if (!active) return elapsedBefore;
    const running = paused ? 0 : performance.now() - startedAt;
    return elapsedBefore + running;
  }

  function startMetering() {
    if (!audioContext || !analyser) return;
    timeDomainData = new Uint8Array(analyser.fftSize);

    const loop = () => {
      if (!active) return;
      if (analyser && timeDomainData && !paused) {
        analyser.getByteTimeDomainData(timeDomainData);
        let sumSquares = 0;
        let peak = 0;
        for (let index = 0; index < timeDomainData.length; index += 1) {
          const sample = (timeDomainData[index] - 128) / 128;
          sumSquares += sample * sample;
          const magnitude = Math.abs(sample);
          if (magnitude > peak) peak = magnitude;
        }
        const rms = Math.sqrt(sumSquares / timeDomainData.length);
        emitLevel({
          // sqrt scaling approximates perceived loudness better than raw RMS
          level: clamp(Math.sqrt(rms) * 1.8, 0, 1),
          rms,
          peak: clamp(peak, 0, 1),
          db: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
        });
      }
      emitTick(getElapsed());
      frameRequest = requestAnimationFrame(loop);
    };
    frameRequest = requestAnimationFrame(loop);
  }

  function stopMetering() {
    if (frameRequest !== null) {
      cancelAnimationFrame(frameRequest);
      frameRequest = null;
    }
  }

  /** Stop every microphone track and close the audio graph. Idempotent. */
  function releaseStream() {
    stopping = true;
    stopMetering();
    if (tapNode) {
      // Disconnect before the context closes so no callback fires on a dead
      // context (Chrome logs a warning and the tap would keep a stale copy).
      tapNode.onaudioprocess = null;
      try {
        tapSource?.disconnect(tapNode);
        tapNode.disconnect(tapSink);
        tapSink?.disconnect();
      } catch {
        /* already disconnected */
      }
      tapSource = null;
      tapNode = null;
      tapSink = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
        track.onended = null;
      }
      stream = null;
    }
    if (audioContext) {
      const context = audioContext;
      audioContext = null;
      analyser = null;
      try {
        context.close?.();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Start a new recording.
   *
   * @param {{
   *   captureMimeType?: string|null,
   *   bitrate?: number,
   *   constraints?: MediaTrackConstraints,
   * }} options
   * @returns {Promise<{ mimeType: string, trackSettings: MediaTrackSettings }>}
   */
  async function start({ captureMimeType = null, bitrate, constraints = {} } = {}) {
    if (active) throw new RecorderError('already-running', 'Recording already in progress');
    if (!isRecordingSupported()) throw new RecorderError('unsupportedBrowser');
    if (!hasSecureContext()) throw new RecorderError('insecureContext');

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch (error) {
      throw new RecorderError(mapMediaError(error), error?.message, error);
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      releaseStream();
      throw new RecorderError('micNotFound', 'The selected device has no audio track');
    }
    stopping = false;
    track.onended = () => {
      if (!stopping) onTrackEnded?.();
    };

    // Level metering graph. Never connected to the destination: no feedback.
    try {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (Context) {
        audioContext = new Context();
        await audioContext.resume?.();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.6;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        if (typeof onAudio === 'function') {
          // Live transcription needs the raw samples, which neither the
          // analyser nor MediaRecorder can hand out. A ScriptProcessor is
          // deprecated but is the only tap that works in every browser this app
          // supports without a separate AudioWorklet module. The zero-gain sink
          // keeps the node in the graph (Chrome only fires callbacks for
          // connected nodes) while staying inaudible.
          const rate = audioContext.sampleRate;
          tapSource = source;
          tapNode = audioContext.createScriptProcessor(4096, 1, 1);
          tapSink = audioContext.createGain();
          tapSink.gain.value = 0;
          tapNode.onaudioprocess = (event) => {
            if (!active || paused) return;
            try {
              // `slice()` because the input buffer is reused by the browser.
              onAudio(event.inputBuffer.getChannelData(0).slice(), rate);
            } catch (error) {
              console.error('[recorder] onAudio failed', error);
            }
          };
          source.connect(tapNode);
          tapNode.connect(tapSink);
          tapSink.connect(audioContext.destination);
        }
      }
    } catch (error) {
      console.warn('[recorder] level metering unavailable', error);
      analyser = null;
    }

    const options = {};
    if (bitrate) options.audioBitsPerSecond = bitrate;
    if (captureMimeType) options.mimeType = captureMimeType;

    try {
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (error) {
      // Some engines reject unsupported option combinations: retry with defaults.
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (fallbackError) {
        releaseStream();
        throw new RecorderError('unsupportedBrowser', fallbackError?.message, fallbackError);
      }
    }

    chunks = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    try {
      // A 1 s timeslice keeps memory bounded and salvages data if the tab dies.
      mediaRecorder.start(1000);
    } catch (error) {
      releaseStream();
      throw new RecorderError('recordFailed', error?.message, error);
    }

    startedAt = performance.now();
    elapsedBefore = 0;
    paused = false;
    active = true;
    startMetering();

    return {
      mimeType: mediaRecorder.mimeType || captureMimeType || 'audio/webm',
      trackSettings: track.getSettings?.() ?? {},
    };
  }

  /** Pause recording. Returns false when the action is not applicable. */
  function pause() {
    if (!mediaRecorder || !active || paused || mediaRecorder.state !== 'recording') return false;
    try {
      mediaRecorder.pause();
    } catch {
      return false;
    }
    elapsedBefore += performance.now() - startedAt;
    paused = true;
    return true;
  }

  /** Resume a paused recording. Returns false when not paused. */
  function resume() {
    if (!mediaRecorder || !active || !paused || mediaRecorder.state !== 'paused') return false;
    try {
      mediaRecorder.resume();
    } catch {
      return false;
    }
    startedAt = performance.now();
    paused = false;
    return true;
  }

  /**
   * Stop and resolve with the recorded blob. Always releases the microphone,
   * even when the recorder throws.
   *
   * @returns {Promise<{ blob: Blob, mimeType: string, durationMs: number }>}
   */
  function stop() {
    const recorder = mediaRecorder;
    if (!recorder || !active) {
      releaseStream();
      return Promise.reject(new RecorderError('noStream', 'Nothing is being recorded'));
    }

    return new Promise((resolve, reject) => {
      const durationMs = Math.round(getElapsed());
      const mimeType = recorder.mimeType || 'audio/webm';
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        active = false;
        paused = false;
        elapsedBefore = durationMs;
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];
        mediaRecorder = null;
        releaseStream();
        if (blob.size === 0) {
          reject(new RecorderError('recordFailed', 'The recording is empty'));
          return;
        }
        resolve({ blob, mimeType, durationMs });
      };

      recorder.onstop = finish;
      recorder.onerror = (event) => {
        if (settled) return;
        settled = true;
        active = false;
        mediaRecorder = null;
        releaseStream();
        reject(new RecorderError('recordFailed', event?.error?.message ?? 'MediaRecorder error'));
      };

      try {
        if (recorder.state === 'inactive') {
          finish();
        } else {
          recorder.stop();
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          active = false;
          mediaRecorder = null;
          releaseStream();
          reject(new RecorderError('recordFailed', error?.message, error));
        }
      }
    });
  }

  /** Abort a recording without producing a blob; releases the microphone. */
  function cancel() {
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
      }
    } catch {
      /* ignore */
    }
    mediaRecorder = null;
    active = false;
    paused = false;
    chunks = [];
    elapsedBefore = 0;
    releaseStream();
  }

  return {
    start,
    pause,
    resume,
    stop,
    cancel,
    getElapsed,
    isActive: () => active,
    isPaused: () => paused,
    /** true while a live audio track is held (used for cleanup assertions) */
    hasLiveStream: () => Boolean(stream),
  };
}
