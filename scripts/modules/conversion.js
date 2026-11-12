/**
 * Shared contract for audio conversions (WAV today, MP3 in a later phase).
 *
 * A conversion is long running: decoding a five minute clip and re-encoding it
 * as PCM blocks the main thread for hundreds of milliseconds, so every job must
 *
 *  - report real progress derived from the work it has actually finished,
 *  - notice a cancellation request between chunks and stop promptly,
 *  - release its listeners even when it fails, and
 *  - fail with a distinguishable error so the UI can tell "cancelled" from
 *    "broken" without string matching.
 *
 * Everything here is pure (no DOM, no Web Audio), which is why
 * tests/unit/conversion.test.js can cover it in Node.
 */

/** Stages every conversion reports, in order. */
export const CONVERSION_STAGES = Object.freeze({
  /** Decoding the recorded container: duration unknown, progress indeterminate. */
  DECODE: 'decode',
  /** Encoding PCM output: progress is frames written / total frames. */
  ENCODE: 'encode',
});

/** Thrown when the caller aborts a conversion. Never shown as an error. */
export class ConversionCancelledError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = 'Conversion cancelled') {
    super(message);
    this.name = 'ConversionCancelledError';
    this.code = 'conversionCancelled';
  }
}

/**
 * True for a cancellation, including one that crossed a realm boundary (an
 * AbortError raised by a platform API) where `instanceof` no longer works.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConversionCancelled(error) {
  if (error instanceof ConversionCancelledError) return true;
  const candidate = /** @type {{ name?: string, code?: string }} */ (error);
  return (
    candidate?.name === 'ConversionCancelledError' ||
    candidate?.code === 'conversionCancelled' ||
    candidate?.name === 'AbortError'
  );
}

/**
 * Clamp an arbitrary value into the 0..1 progress range.
 * @param {unknown} value
 * @returns {number}
 */
export function clampFraction(value) {
  const fraction = Number(value);
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * @typedef {{ stage: string, fraction: number|null }} ConversionProgress
 * `fraction` is null while the stage has no measurable progress (decode).
 */

/**
 * Track one conversion: progress reporting, cancellation and cleanup.
 *
 * @param {{
 *   signal?: AbortSignal|null,
 *   onProgress?: ((progress: ConversionProgress) => void)|null,
 * }} [options]
 */
export function createConversionTask({ signal = null, onProgress = null } = {}) {
  // Read `aborted` eagerly too: a signal can already be aborted when handed over,
  // and fake signals in tests may not expose a live property.
  let aborted = Boolean(signal?.aborted);
  let disposed = false;
  let stage = CONVERSION_STAGES.DECODE;
  /** @type {number|null} */
  let lastFraction = null;

  const handleAbort = () => {
    aborted = true;
  };
  if (signal) signal.addEventListener('abort', handleAbort, { once: true });

  const task = {
    /** The caller's signal, forwarded to chunked encoders. */
    get signal() {
      return signal;
    },

    /** Has a cancellation been requested? */
    get cancelled() {
      if (aborted) return true;
      if (signal?.aborted) {
        aborted = true;
        return true;
      }
      return false;
    },

    /** Current stage name. */
    get stage() {
      return stage;
    },

    /** @throws {ConversionCancelledError} when the caller aborted. */
    throwIfCancelled() {
      if (task.cancelled) throw new ConversionCancelledError();
    },

    /**
     * Report progress for a stage.
     *
     * Fractions inside a stage never move backwards (browsers coalesce paints
     * and a jittery bar reads as a bug), while switching stage resets the
     * reference point.
     *
     * @param {string} nextStage
     * @param {number|null} [fraction] null/undefined for an indeterminate stage
     */
    report(nextStage, fraction = null) {
      if (disposed) return;
      if (nextStage !== stage) {
        stage = nextStage;
        lastFraction = null;
      }
      let value = fraction === null || fraction === undefined ? null : clampFraction(fraction);
      if (value !== null && lastFraction !== null && value < lastFraction) {
        value = lastFraction;
      }
      if (value !== null) lastFraction = value;
      if (onProgress) onProgress({ stage, fraction: value });
    },

    /** Drop the abort listener and stop reporting. Safe to call twice. */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (signal) signal.removeEventListener('abort', handleAbort);
      onProgress = null;
    },
  };

  return task;
}
