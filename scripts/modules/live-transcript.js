/**
 * Live (partial) transcription while a recording is in progress.
 *
 * The recorder hands us raw microphone frames; once enough new audio has piled
 * up we transcribe that slice and append the result to the running caption. It
 * is a *preview*: the authoritative transcript is produced afterwards from the
 * saved audio, because a preview can miss words while the CPU is busy encoding
 * the recording.
 *
 * The module is deliberately transport-agnostic: `transcribe` is injected, so it
 * can be unit tested without a worker, a model or a browser.
 */

/** Below this much new audio there is nothing worth decoding yet. */
export const LIVE_MIN_SECONDS = 4;

/** Never send more than this in one go: it keeps the caption responsive. */
export const LIVE_MAX_SECONDS = 15;

/**
 * @param {{
 *   transcribe: (samples: Float32Array, options: { sampleRate: number }) => Promise<{ text?: string }>,
 *   onUpdate?: (state: { text: string, busy: boolean }) => void,
 *   onError?: (error: unknown) => void,
 *   minSeconds?: number,
 *   maxSeconds?: number,
 * }} options
 */
export function createLiveTranscript({
  transcribe,
  onUpdate,
  onError,
  minSeconds = LIVE_MIN_SECONDS,
  maxSeconds = LIVE_MAX_SECONDS,
} = {}) {
  /** @type {Float32Array[]} */
  let buffers = [];
  let buffered = 0;
  let sampleRate = 0;
  let busy = false;
  let active = true;
  /** a push arrived while the previous slice was still decoding */
  let queued = false;
  let text = '';

  const emit = () => {
    try {
      onUpdate?.({ text, busy });
    } catch (error) {
      console.error('[live-asr] onUpdate failed', error);
    }
  };

  const takeSamples = () => {
    const limit = Math.max(1, Math.round(maxSeconds * sampleRate));
    const total = Math.min(buffered, limit);
    const output = new Float32Array(total);
    let offset = 0;
    while (offset < total && buffers.length > 0) {
      const head = buffers[0];
      const room = total - offset;
      if (head.length <= room) {
        output.set(head, offset);
        offset += head.length;
        buffers.shift();
      } else {
        output.set(head.subarray(0, room), offset);
        buffers[0] = head.subarray(room);
        offset += room;
      }
    }
    buffered = Math.max(0, buffered - total);
    return output;
  };

  async function run() {
    if (!active || busy) return;
    const minimum = Math.max(0.5, minSeconds) * sampleRate;
    if (buffered < minimum || typeof transcribe !== 'function') return;

    busy = true;
    queued = false;
    emit();
    const slice = takeSamples();
    const rate = sampleRate;

    try {
      const result = await transcribe(slice, { sampleRate: rate });
      if (!active) return;
      const addition = String(result?.text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (addition) {
        text = text ? `${text} ${addition}` : addition;
        emit();
      }
    } catch (error) {
      // A failed preview must not take the recording down with it.
      console.warn('[live-asr] slice failed', error);
      try {
        onError?.(error);
      } catch (handlerError) {
        console.error('[live-asr] onError failed', handlerError);
      }
      active = false;
    } finally {
      busy = false;
      if (active) {
        emit();
        if (queued) run();
      }
    }
  }

  return {
    /**
     * Add microphone samples. `rate` must stay constant for the whole recording;
     * a different rate means a new capture session, so the buffer is reset.
     *
     * @param {Float32Array} samples
     * @param {number} rate
     */
    push(samples, rate) {
      if (!active || !(samples?.length > 0)) return;
      const current = Number(rate) || 0;
      if (!(current > 0)) return;
      if (current !== sampleRate) {
        buffers = [];
        buffered = 0;
        sampleRate = current;
      }
      buffers.push(samples instanceof Float32Array ? samples : Float32Array.from(samples));
      buffered += samples.length;
      if (busy) queued = true;
      else run();
    },
    /** Caption text so far. */
    getText: () => text,
    isBusy: () => busy,
    /** Seconds of audio waiting to be decoded. */
    pendingSeconds: () => (sampleRate > 0 ? buffered / sampleRate : 0),
    /** Forget everything (new recording on the same instance). */
    reset() {
      buffers = [];
      buffered = 0;
      text = '';
      queued = false;
      active = true;
      emit();
    },
    /** Stop listening; an in-flight slice is ignored when it returns. */
    stop() {
      active = false;
      buffers = [];
      buffered = 0;
    },
  };
}
