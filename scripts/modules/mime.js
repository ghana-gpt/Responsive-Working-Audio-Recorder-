/**
 * Audio format / MIME capability detection.
 *
 * Browsers disagree about what MediaRecorder can produce (Chrome/Edge/Firefox
 * record WebM-Opus or OGG-Opus, Safari records MP4/AAC), so the app must never
 * hard-code "audio/webm". Everything here is pure: the caller injects the
 * browser's `MediaRecorder.isTypeSupported` so the logic is unit testable.
 */

/**
 * Ordered list of containers/codecs we try, best first.
 * `formatId` groups candidates into the user facing format picker.
 */
export const RECORDER_CANDIDATES = [
  { mimeType: 'audio/webm;codecs=opus', formatId: 'webm', extension: 'webm' },
  { mimeType: 'audio/webm', formatId: 'webm', extension: 'webm' },
  { mimeType: 'audio/ogg;codecs=opus', formatId: 'ogg', extension: 'ogg' },
  { mimeType: 'audio/ogg', formatId: 'ogg', extension: 'ogg' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', formatId: 'mp4', extension: 'm4a' },
  { mimeType: 'audio/mp4', formatId: 'mp4', extension: 'm4a' },
  { mimeType: 'audio/aac', formatId: 'mp4', extension: 'aac' },
  { mimeType: 'audio/mpeg', formatId: 'mp3', extension: 'mp3' },
];

/**
 * Formats offered in the UI. `conversion` means the browser cannot record it
 * directly and the app encodes it in JavaScript after capture.
 */
export const FORMAT_OPTIONS = [
  { id: 'auto', labelKey: 'settings.formatAuto', extension: null, conversion: null },
  { id: 'webm', labelKey: 'settings.formatWebm', extension: 'webm', conversion: null },
  { id: 'ogg', labelKey: 'settings.formatOgg', extension: 'ogg', conversion: null },
  { id: 'mp4', labelKey: 'settings.formatMp4', extension: 'm4a', conversion: null },
  { id: 'wav', labelKey: 'settings.formatWav', extension: 'wav', conversion: 'wav' },
  {
    id: 'mp3',
    labelKey: 'settings.formatMp3',
    extension: 'mp3',
    conversion: null,
    requiresEncoder: true,
  },
];

/** Map a MIME type to the most useful file extension. */
const EXTENSION_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
};

/** Default no-op capability probe used when MediaRecorder is unavailable. */
export const neverSupported = () => false;

/**
 * Strip codec parameters: "audio/webm;codecs=opus" -> "audio/webm".
 * @param {string} mimeType
 * @returns {string}
 */
export function baseMimeType(mimeType) {
  return String(mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * Extension for a recorded blob, falling back to `fallback`.
 * @param {string} mimeType
 * @param {string} [fallback]
 * @returns {string}
 */
export function extensionForMime(mimeType, fallback = 'webm') {
  return EXTENSION_BY_MIME[baseMimeType(mimeType)] ?? fallback;
}

/**
 * Friendly, human readable name for the container.
 * @param {string} mimeType
 * @returns {string}
 */
export function describeMimeType(mimeType) {
  const base = baseMimeType(mimeType);
  const label = {
    'audio/webm': 'WebM',
    'audio/ogg': 'OGG',
    'audio/mp4': 'MP4 (AAC)',
    'audio/aac': 'AAC',
    'audio/mpeg': 'MP3',
    'audio/wav': 'WAV',
    'audio/wave': 'WAV',
    'audio/x-wav': 'WAV',
  }[base];
  if (label && /codecs=opus/i.test(String(mimeType))) return `${label} / Opus`;
  return label || base || 'Audio';
}

/**
 * All recording candidates this browser can actually produce, best first.
 * @param {(mimeType: string) => boolean} isTypeSupported
 * @returns {typeof RECORDER_CANDIDATES}
 */
export function listSupportedCandidates(isTypeSupported = neverSupported) {
  try {
    return RECORDER_CANDIDATES.filter((candidate) => {
      try {
        return Boolean(isTypeSupported(candidate.mimeType));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Pick the best capture container, optionally restricted to one format family.
 * @param {string} [formatId]
 * @param {(mimeType: string) => boolean} [isTypeSupported]
 * @returns {{ mimeType: string, formatId: string, extension: string } | null}
 */
export function pickCaptureCandidate(formatId, isTypeSupported = neverSupported) {
  const supported = listSupportedCandidates(isTypeSupported);
  if (supported.length === 0) return null;
  if (!formatId || formatId === 'auto' || formatId === 'wav') return supported[0];
  return supported.find((candidate) => candidate.formatId === formatId) ?? null;
}

/**
 * Resolve the user's format choice into a concrete recording plan.
 *
 * Result shape:
 * {
 *   requestedId, supported, label,
 *   captureMimeType, outputMimeType, extension,
 *   conversion: null | 'wav',
 *   reason: null | 'unsupported' | 'needs-encoder' | 'no-recorder'
 * }
 *
 * @param {string} formatId one of FORMAT_OPTIONS ids
 * @param {(mimeType: string) => boolean} [isTypeSupported]
 * @returns {object}
 */
export function resolveFormat(formatId, isTypeSupported = neverSupported) {
  const requested = FORMAT_OPTIONS.find((option) => option.id === formatId) ?? FORMAT_OPTIONS[0];
  const best = pickCaptureCandidate(null, isTypeSupported);

  if (!best) {
    return {
      requestedId: requested.id,
      supported: false,
      label: requested.id,
      captureMimeType: null,
      outputMimeType: null,
      extension: requested.extension ?? 'webm',
      conversion: null,
      reason: 'no-recorder',
    };
  }

  // WAV is not recordable by MediaRecorder anywhere: capture compressed audio
  // and encode 16-bit PCM in JS afterwards (see modules/wav.js).
  if (requested.conversion === 'wav') {
    return {
      requestedId: requested.id,
      supported: true,
      label: 'WAV (PCM 16-bit)',
      captureMimeType: best.mimeType,
      outputMimeType: 'audio/wav',
      extension: 'wav',
      conversion: 'wav',
      reason: null,
    };
  }

  if (requested.id === 'auto') {
    return {
      requestedId: 'auto',
      supported: true,
      label: describeMimeType(best.mimeType),
      captureMimeType: best.mimeType,
      outputMimeType: best.mimeType,
      extension: best.extension,
      conversion: null,
      reason: null,
    };
  }

  const exact = pickCaptureCandidate(requested.id, isTypeSupported);
  if (!exact) {
    return {
      requestedId: requested.id,
      supported: false,
      label: requested.id,
      captureMimeType: null,
      outputMimeType: null,
      extension: requested.extension ?? 'webm',
      conversion: null,
      reason: requested.requiresEncoder ? 'needs-encoder' : 'unsupported',
    };
  }

  return {
    requestedId: requested.id,
    supported: true,
    label: describeMimeType(exact.mimeType),
    captureMimeType: exact.mimeType,
    outputMimeType: exact.mimeType,
    extension: exact.extension,
    conversion: null,
    reason: null,
  };
}

/**
 * Build the availability map used to disable unsupported options in the UI.
 * @param {(mimeType: string) => boolean} [isTypeSupported]
 * @returns {Record<string, { available: boolean, reason: string|null }>}
 */
export function formatAvailability(isTypeSupported = neverSupported) {
  /** @type {Record<string, { available: boolean, reason: string|null }>} */
  const result = {};
  for (const option of FORMAT_OPTIONS) {
    const resolved = resolveFormat(option.id, isTypeSupported);
    result[option.id] = { available: resolved.supported, reason: resolved.reason };
  }
  return result;
}
