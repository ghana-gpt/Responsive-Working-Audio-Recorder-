/**
 * Application orchestrator.
 *
 * This is the only module that knows about *everything*: it owns the state
 * machine, the IndexedDB repository, the recorder engine, the views and the
 * service worker. Each collaborator stays small and testable; wiring lives here.
 */

import {
  ASR_MODEL_BYTES,
  ASR_MODEL_LABEL,
  buildTranscript,
  createTranscriber,
  downmixToMono,
  formatSrt,
  formatTranscriptText,
  isAsrSupported,
} from './modules/asr.js';
import {
  analyzeWaveform,
  convertToMp3,
  convertToWav,
  decodeBlob,
  downloadBlob,
  shareRecording,
  trimToWav,
} from './modules/audio-utils.js';
import {
  estimateStorage,
  isIndexedDbSupported,
  requestPersistentStorage,
  storageLevel,
  storagePercent,
} from './modules/db.js';
import { createDialogs } from './modules/dialogs.js';
import { isConversionCancelled } from './modules/conversion.js';
import { createConversionView } from './modules/conversion-view.js';
import { $, isEditableTarget, setFlag, translateTree } from './modules/dom.js';
import { buildFileName, formatBytes, timestampForFilename } from './modules/format.js';
import {
  createTranslator,
  errorKeyForCode,
  resolveLocale,
  SUPPORTED_LOCALES,
} from './modules/i18n.js';
import { createLibraryView } from './modules/library-view.js';
import { LIBRARY_PAGE_SIZE, SORT_OPTIONS, pageWindow, topRecordings } from './modules/library.js';
import { createLiveTranscript } from './modules/live-transcript.js';
import { extensionForMime, resolveFormat } from './modules/mime.js';
import { MP3_ENCODER_AVAILABLE } from './modules/mp3.js';
import {
  buildAudioConstraints,
  createRecorder,
  hasSecureContext,
  isRecordingSupported,
} from './modules/recorder.js';
import { createRecorderView } from './modules/recorder-view.js';
import { parseTags, sanitizeDisplayName, sanitizeFileName } from './modules/sanitize.js';
import { createSettingsView } from './modules/settings-view.js';
import { applyTheme, loadSettings, resetSettings, saveSettings } from './modules/settings.js';
import { ACTIONS, MODES, PLAYBACK, createStore } from './modules/state.js';
import { createId, createRepository } from './modules/store.js';
import { createToaster } from './modules/toast.js';
import { crc32Blob, createZipParts, dedupeNames, estimateZipSize } from './modules/zip.js';
import { extractZipEntry, readZipDirectory } from './modules/zip-reader.js';

/** Capability probe injected into the pure MIME helpers. */
function isTypeSupported(mimeType) {
  try {
    return Boolean(globalThis.MediaRecorder?.isTypeSupported?.(mimeType));
  } catch {
    return false;
  }
}

/** Everything the UI needs to remember between renders. */
const app = {
  settings: loadSettings(),
  locale: 'en',
  t: createTranslator('en'),
  /** current recording plan from modules/mime.js (capture + output format) */
  plan: null,
  query: '',
  sort: 'newest',
  /** how many matching rows the library currently renders (\"show more\" grows it) */
  visible: LIBRARY_PAGE_SIZE,
  /** @type {Set<string>} ids selected in the library */
  selection: new Set(),
  /** @type {string|null} recording currently loaded in the preview player */
  activeId: null,
  playing: false,
  storageProtected: null,
  /** last `navigator.storage.estimate()` result, or null when unsupported */
  storage: null,
  /** has the "storage almost full" toast already been shown this session? */
  quotaWarned: false,
  /** object URL of the preview player, revoked when it changes */
  objectUrl: null,
  installPrompt: null,
  /** id of the recording being transcribed right now, or null */
  transcribingId: null,
  /** true while the opt-in live caption is feeding the shared worker */
  liveCaptionActive: false,
  /** @type {AbortController|null} the transcription the cancel button targets */
  transcribeAbort: null,
};

/** Views and services, created in `init()`. */
let store;
let repo;
let recorder;
let recorderView;
let libraryView;
let settingsView;
let dialogs;
let toaster;
let conversionView;
/** @type {AbortController|null} the conversion currently on screen, if any */
let conversionJob = null;
/** Main-thread client for the transcription worker (created in `init`). */
let transcriber = null;
/** Live caption preview (created in `init`). */
let liveTranscript = null;

/** Bound translator: always reads the current locale. */
const t = (key, params) => app.t(key, params);

/**
 * Resolve an error code to a localised message (never returns a raw key).
 *
 * Recorder errors use camelCase codes (`micDenied`) while storage errors use
 * kebab-case (`quota-exceeded`), so both spellings are accepted.
 */
function errorMessage(code, message = '') {
  const raw = String(code ?? 'unknown');
  const key = errorKeyForCode(raw);
  const text = t(key, { message });
  return text === key ? t('errors.unknown', { message: message || raw }) : text;
}

// -------------------------------------------------------------- conversion ---

/**
 * Show the progress panel and hand the caller the options `convertToWav` /
 * `trimToWav` expect.
 *
 * Only one conversion may run at a time: it is CPU bound, the panel has a single
 * cancel button, and two jobs would fight over the same live region.
 *
 * @param {string} labelKey i18n key describing the operation
 * @returns {{ signal: AbortSignal, onProgress: (update: object) => void }|null}
 */
function beginConversion(labelKey) {
  if (conversionJob) {
    toaster.show({ message: t('errors.conversionBusy'), tone: 'error' });
    return null;
  }
  conversionJob = new AbortController();
  conversionView.start(labelKey);
  return {
    signal: conversionJob.signal,
    onProgress: (update) => conversionView.update(update),
  };
}

/** Hide the panel and forget the job (success, failure or cancellation). */
function endConversion() {
  conversionJob = null;
  conversionView.stop();
}

/** Cancel button / page hide: the encoder stops between chunks. */
function cancelConversion() {
  conversionJob?.abort();
}

/**
 * Explain a cancelled conversion: nothing was saved, and that is not an error.
 * @param {string} [logLabel]
 */
function reportConversionCancelled(logLabel = 'conversion') {
  console.info(`[${logLabel}] cancelled by user`);
  toaster.show({ message: t('toast.conversionCancelled'), tone: 'info' });
}

// ---------------------------------------------------------------- recorder ---

/** Resolve the current format preference against browser capabilities. */
function currentPlan() {
  return resolveFormat(app.settings.format, isTypeSupported, MP3_ENCODER_AVAILABLE);
}

/** Show "Will record as …" above the timer. */
function updateFormatHint() {
  // While a capture is running the hint must describe *that* capture, and
  // `app.plan` is what the save path uses: changing the preference mid-recording
  // must not rewrite the plan of the file being recorded.
  const { mode } = store?.getState() ?? {};
  const capturing = mode === MODES.RECORDING || mode === MODES.PAUSED;
  if (capturing && app.plan) return;

  app.plan = currentPlan();
  recorderView.setFormatHint(t('misc.formatHint', { format: app.plan.label }));
}

/**
 * A stored format may not exist in this browser (MP3 in Firefox, OGG in Safari).
 * Fall back to `auto` so the preferences radio, the hint and the recorder agree
 * instead of failing on every press of the record button.
 */
function reconcileFormatPreference() {
  // A browser without MediaRecorder supports no format at all: keep the
  // preference for the next device instead of rewriting it.
  if (!isRecordingSupported()) return;
  if (currentPlan().supported) return;
  app.settings = saveSettings({ format: 'auto' });
}

/** Surface a failure in the error panel when possible, else as a toast. */
function reportError(error, fallbackCode = 'recordFailed') {
  const code = error?.code ?? fallbackCode;
  const message = error?.message ?? '';
  if (store.dispatch(ACTIONS.FAIL, { code, message })) {
    recorderView.setElapsed(0);
    return;
  }
  toaster.show({ message: errorMessage(code, message), tone: 'error' });
}

async function handleRequest() {
  const mode = store.getState().mode;
  if (mode === MODES.RECORDING || mode === MODES.PAUSED) return;

  if (!isRecordingSupported()) {
    store.dispatch(ACTIONS.FAIL, { code: 'unsupportedBrowser', message: '' });
    return;
  }
  if (!hasSecureContext()) {
    store.dispatch(ACTIONS.FAIL, { code: 'insecureContext', message: '' });
    return;
  }

  const plan = currentPlan();
  if (!plan.supported) {
    store.dispatch(ACTIONS.FAIL, {
      code: plan.reason === 'needs-encoder' ? 'invalidFormat' : 'unsupportedBrowser',
      message: plan.label,
    });
    return;
  }

  if (!store.dispatch(ACTIONS.REQUEST)) return;
  app.plan = { ...plan, bitrate: app.settings.bitrate };
  recorderView.setElapsed(0);

  try {
    const { trackSettings } = await recorder.start({
      captureMimeType: plan.captureMimeType,
      // Converted formats use the selected bitrate in their encoder afterwards.
      bitrate: plan.conversion ? undefined : app.plan.bitrate,
      constraints: buildAudioConstraints(app.settings),
    });
    store.dispatch(ACTIONS.START);
    recorderView.setFormatHint(t('misc.formatHint', { format: plan.label }));
    recorderView.setMicrophoneHint(trackSettings);
    startLiveCaption();
  } catch (error) {
    reportError(error);
  }
}

function handlePause() {
  if (recorder.pause()) store.dispatch(ACTIONS.PAUSE);
}

function handleResume() {
  if (recorder.resume()) store.dispatch(ACTIONS.RESUME);
}

/**
 * Stop the recorder, persist the audio and return to a ready state.
 * @param {{ reason?: string }} [options]
 */
async function handleFinish({ reason = '' } = {}) {
  if (!store.dispatch(ACTIONS.FINISH)) return;
  // The capture is over: free the worker for the real transcription the user
  // may ask for next (a late preview answer is discarded by the module).
  stopLiveCaption();
  try {
    const { blob, mimeType, durationMs } = await recorder.stop();
    const plan = app.plan ?? currentPlan();

    let outputBlob = blob;
    let outputMime = mimeType || plan.outputMimeType || 'audio/webm';
    let extension = extensionForMime(outputMime, plan.extension || 'webm');

    if (plan.conversion === 'wav' || plan.conversion === 'mp3') {
      const isMp3 = plan.conversion === 'mp3';
      const job = beginConversion(isMp3 ? 'conversion.convertingMp3' : 'conversion.convertingWav');
      if (!job) {
        // Another conversion owns the panel; its toast already explained why.
        store.dispatch(ACTIONS.CANCEL);
        updateFormatHint();
        return;
      }
      try {
        if (isMp3) {
          outputBlob = await convertToMp3(blob, {
            ...job,
            bitrate: plan.bitrate ?? app.settings.bitrate,
          });
          outputMime = 'audio/mpeg';
          extension = 'mp3';
        } else {
          outputBlob = await convertToWav(blob, job);
          outputMime = 'audio/wav';
          extension = 'wav';
        }
      } catch (error) {
        if (isConversionCancelled(error)) {
          // The capture is gone and nothing was persisted: back to a usable state.
          store.dispatch(ACTIONS.CANCEL);
          updateFormatHint();
          reportConversionCancelled('recorder');
          return;
        }
        throw Object.assign(new Error(error?.message ?? 'conversion failed'), {
          code: 'conversionFailed',
        });
      } finally {
        endConversion();
      }
    }

    const record = await repo.create({
      blob: outputBlob,
      name: repo.suggestName(t('misc.recording')),
      mimeType: outputMime,
      extension,
      durationMs,
    });

    store.dispatch(ACTIONS.COMPLETE);
    updateFormatHint();
    toaster.show({ message: t('toast.saved', { name: record.name }), tone: 'success' });
    if (reason === 'track-ended') {
      toaster.show({ message: t('errors.noStream'), tone: 'error' });
    }
    await renderLibrary();
    await refreshStorage();
  } catch (error) {
    // The microphone worked; persisting or converting failed. Drop back to a
    // usable state and explain through a toast instead of showing the
    // "microphone problem" panel, whose retry button starts a *new* recording.
    store.dispatch(ACTIONS.CANCEL);
    updateFormatHint();
    const code = error?.code ?? 'saveFailed';
    toaster.show({ message: errorMessage(code, error?.message ?? ''), tone: 'error' });
    console.warn('[recorder] could not save', error);
  }
}

/** Abort the recording in progress without saving anything. */
function handleCancel() {
  recorder.cancel();
  stopLiveCaption();
  if (!store.dispatch(ACTIONS.CANCEL)) store.dispatch(ACTIONS.RESET);
  updateFormatHint();
}

// --------------------------------------------------------------- playback ---

/** @returns {HTMLAudioElement|null} */
function previewAudio() {
  return /** @type {HTMLAudioElement|null} */ ($('#preview-audio'));
}

/** Unload whatever the preview player is holding and release its object URL. */
function stopPlayback() {
  const audio = previewAudio();
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setFlag(audio, 'hidden', true);
  }
  if (app.objectUrl) {
    URL.revokeObjectURL(app.objectUrl);
    app.objectUrl = null;
  }
  app.activeId = null;
  app.playing = false;
  store.setPlayback(PLAYBACK.IDLE);
}

/** Play a recording, or pause it when it is already the active one. */
async function togglePlayback(id) {
  const record = repo.get(id);
  const audio = previewAudio();
  if (!record || !audio) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }

  if (app.activeId === id && !audio.paused) {
    audio.pause();
    return;
  }

  if (app.activeId !== id) {
    /** @type {Blob|undefined} */
    let blob;
    try {
      blob = await repo.blobFor(id);
    } catch (error) {
      toaster.show({ message: errorMessage('unknown', error?.message ?? ''), tone: 'error' });
      return;
    }
    if (!blob) {
      toaster.show({ message: t('errors.notFound'), tone: 'error' });
      return;
    }
    if (app.objectUrl) URL.revokeObjectURL(app.objectUrl);
    app.objectUrl = URL.createObjectURL(blob);
    audio.src = app.objectUrl;
    audio.hidden = false;
    audio.setAttribute('aria-label', t('recording.preview', { name: record.name }));
    app.activeId = id;
  }

  try {
    await audio.play();
  } catch (error) {
    toaster.show({ message: errorMessage('unknown', error?.message ?? 'playback'), tone: 'error' });
  }
}

// ---------------------------------------------------------------- library ---

/** Ids in the selection that still exist. */
function selectedIds() {
  return [...app.selection].filter((id) => Boolean(repo.get(id)));
}

/** Drop ids that were deleted elsewhere so the counter never lies. */
function pruneSelection() {
  const existing = new Set(repo.all().map((record) => record.id));
  for (const id of [...app.selection]) {
    if (!existing.has(id)) app.selection.delete(id);
  }
}

/** Re-render the library, its counters and the statistics block. */
function renderLibrary() {
  pruneSelection();
  const matching = repo.list({ query: app.query, sort: app.sort });
  const page = pageWindow(matching, app.visible);
  libraryView.render({
    records: page.records,
    total: repo.all().length,
    matching: page.total,
    hasMore: page.hasMore,
    query: app.query,
    sort: app.sort,
    selection: app.selection,
    activeId: app.activeId,
    playing: app.playing,
    locale: app.locale,
    transcribingId: app.transcribingId,
  });
  renderSettings();
}

// ------------------------------------------------------- library: actions ---

async function downloadRecording(id) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  /** @type {Blob|undefined} */
  let blob;
  try {
    blob = await repo.blobFor(id);
  } catch (error) {
    toaster.show({ message: errorMessage('unknown', error?.message ?? ''), tone: 'error' });
    return;
  }
  if (!blob) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  downloadBlob(
    blob,
    buildFileName({
      name: sanitizeFileName(record.name),
      extension: record.extension,
      date: record.createdAt ? new Date(record.createdAt) : new Date(),
    }),
  );
  toaster.show({ message: t('toast.downloaded'), tone: 'success' });
}

async function shareRecordingById(id) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  /** @type {Blob|undefined} */
  let blob;
  try {
    blob = await repo.blobFor(id);
  } catch (error) {
    toaster.show({ message: errorMessage('unknown', error?.message ?? ''), tone: 'error' });
    return;
  }
  if (!blob) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  const result = await shareRecording(
    blob,
    buildFileName({
      name: sanitizeFileName(record.name),
      extension: record.extension,
      date: record.createdAt ? new Date(record.createdAt) : new Date(),
    }),
    { title: record.name, text: t('app.title') },
  );
  if (result === 'shared') {
    toaster.show({ message: t('toast.shared', { name: record.name }), tone: 'success' });
  } else if (result === 'unsupported') {
    toaster.show({ message: t('errors.shareUnavailable'), tone: 'error' });
  }
}

/** Ask for a range, then save the trimmed copy as a new WAV recording. */
async function trimRecording(id) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }

  /** @type {Blob|undefined} */
  let sourceBlob;
  try {
    sourceBlob = await repo.blobFor(id);
  } catch (error) {
    toaster.show({ message: errorMessage('unknown', error?.message ?? ''), tone: 'error' });
    return;
  }
  if (!sourceBlob) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }

  let analysis;
  try {
    analysis = await analyzeWaveform(sourceBlob, 240);
  } catch {
    analysis = null; // waveform is optional; the sliders still work
  }
  const duration = analysis?.duration ?? (Number(record.durationMs) || 0) / 1000;
  if (!(duration > 0.2)) {
    toaster.show({ message: t('errors.decodeFailed'), tone: 'error' });
    return;
  }

  const range = await dialogs.openTrim({
    name: record.name || t('recording.untitled'),
    duration,
    peaks: analysis?.peaks ?? null,
  });
  if (!range) return;

  const job = beginConversion('conversion.trimmingWav');
  if (!job) return;

  try {
    const trimmed = await trimToWav(sourceBlob, range.startSeconds, range.endSeconds, job);
    const name = `${record.name || t('recording.untitled')} (${t('recording.trimmed')})`;
    const created = await repo.create({
      blob: trimmed.blob,
      name,
      mimeType: 'audio/wav',
      extension: 'wav',
      durationMs: Math.round(trimmed.duration * 1000),
      sourceId: record.id,
      trimmed: true,
    });
    toaster.show({ message: t('toast.trimmed', { name: created.name }), tone: 'success' });
    renderLibrary();
    await refreshStorage();
  } catch (error) {
    if (isConversionCancelled(error)) {
      reportConversionCancelled('trim');
    } else {
      toaster.show({
        message: t('errors.trimFailed', { message: error?.message ?? '' }),
        tone: 'error',
      });
    }
  } finally {
    endConversion();
  }
}

async function renameRecording(id, name, tags) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  const cleanName = sanitizeDisplayName(name, record.name || t('recording.untitled'));
  const cleanTags = parseTags(tags);
  try {
    await repo.update(id, { name: cleanName, tags: cleanTags });
    toaster.show({ message: t('toast.renamed', { name: cleanName }), tone: 'success' });
  } catch (error) {
    toaster.show({
      message: t('errors.saveFailed', { message: error?.message ?? '' }),
      tone: 'error',
    });
  }
  renderLibrary();
}

async function deleteRecording(id) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  const confirmed = await dialogs.confirm({
    title: t('dialog.deleteTitle'),
    body: t('dialog.deleteBody', { name: record.name || t('recording.untitled') }),
    acceptLabel: t('actions.delete'),
  });
  if (!confirmed) return;

  try {
    await repo.remove(id);
    app.selection.delete(id);
    if (app.activeId === id) stopPlayback();
    toaster.show({ message: t('toast.deleted', { name: record.name }), tone: 'success' });
  } catch (error) {
    toaster.show({
      message: t('errors.saveFailed', { message: error?.message ?? '' }),
      tone: 'error',
    });
  }
  renderLibrary();
  await refreshStorage();
}

/** Delete every selected recording after a single confirmation. */
async function deleteSelection() {
  const ids = selectedIds();
  if (ids.length === 0) return;
  const confirmed = await dialogs.confirm({
    title: t('dialog.deleteSelectedTitle'),
    body: t('dialog.deleteSelectedBody', { count: ids.length }),
    acceptLabel: t('actions.delete'),
  });
  if (!confirmed) return;

  let removed;
  try {
    removed = await repo.removeMany(ids);
  } catch (error) {
    toaster.show({ message: errorMessage('unknown', error?.message ?? ''), tone: 'error' });
    return;
  }
  for (const id of ids) app.selection.delete(id);
  if (app.activeId && ids.includes(app.activeId)) stopPlayback();
  toaster.show({ message: t('toast.deletedAll', { count: removed }), tone: 'success' });
  renderLibrary();
  await refreshStorage();
}

/** Wipe the whole library. */
async function clearAll() {
  const total = repo.all().length;
  if (total === 0) return;
  const confirmed = await dialogs.confirm({
    title: t('dialog.deleteAllTitle'),
    body: t('dialog.deleteAllBody', { count: total }),
    acceptLabel: t('actions.delete'),
  });
  if (!confirmed) return;

  try {
    await repo.clear();
    app.selection.clear();
    stopPlayback();
    toaster.show({ message: t('toast.deletedAll', { count: total }), tone: 'success' });
  } catch (error) {
    toaster.show({
      message: t('errors.saveFailed', { message: error?.message ?? '' }),
      tone: 'error',
    });
  }
  renderLibrary();
  await refreshStorage();
}

/** Archives above this estimated size ask for confirmation first. */
const LARGE_EXPORT_BYTES = 512 * 1024 * 1024;

/** Bundle the given recordings into a single ZIP download. */
async function zipRecordings(records) {
  const list = (records ?? []).filter((record) => record?.id);
  if (list.length === 0) {
    toaster.show({ message: t('toast.noRecordings') });
    return;
  }

  try {
    const names = dedupeNames(
      list.map((record) =>
        buildFileName({
          name: sanitizeFileName(record.name),
          extension: record.extension,
          date: record.createdAt ? new Date(record.createdAt) : new Date(),
        }),
      ),
    );

    // Blobs stay Blobs: the archive is assembled as parts, so a multi-gigabyte
    // export never needs one contiguous in-memory buffer.
    const entries = [];
    for (const [index, record] of list.entries()) {
      const blob = await repo.blobFor(record.id);
      if (!blob) continue; // metadata without payload: skip instead of failing
      entries.push({
        name: names[index],
        source: blob,
        // The writer derives every offset from this size, so it must describe
        // the bytes actually written — never the (possibly stale) metadata.
        size: blob.size,
        crc: await crc32Blob(blob),
      });
    }

    if (entries.length === 0) {
      toaster.show({ message: t('toast.noRecordings') });
      return;
    }

    const estimated = estimateZipSize(entries);
    if (estimated > LARGE_EXPORT_BYTES) {
      const confirmed = await dialogs.confirm({
        title: t('dialog.largeExportTitle'),
        body: t('dialog.largeExportBody', { size: formatBytes(estimated) }),
        acceptLabel: t('actions.download'),
      });
      if (!confirmed) return;
    }

    const { parts } = createZipParts(entries, { date: new Date() });
    downloadBlob(
      new Blob(parts, { type: 'application/zip' }),
      `audio-recordings_${timestampForFilename()}.zip`,
    );
    toaster.show({ message: t('toast.zipped', { count: entries.length }), tone: 'success' });
  } catch (error) {
    toaster.show({ message: t('errors.zipFailed'), tone: 'error' });
    console.warn('[zip] failed', error);
  }
}

/** Audio formats a restored archive may contain, keyed by file extension. */
const ARCHIVE_MIME_TYPES = {
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
};

/** Lower-case extension of a file name (no dot), or an empty string. */
function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** Is this picked file a ZIP archive rather than a single audio file? */
function isArchive(file) {
  const type = String(file?.type ?? '').toLowerCase();
  return (
    type === 'application/zip' ||
    type === 'application/x-zip-compressed' ||
    extensionOf(file?.name) === 'zip'
  );
}

/**
 * Restore recordings from a ZIP archive this app exported earlier.
 *
 * Every entry is checksum-verified against the central directory before it is
 * stored, so a damaged download can never corrupt the library: bad entries are
 * skipped (and reported) instead of aborting the whole restore. Audio that is
 * intact but that this browser cannot decode is still restored (unknown
 * duration) rather than thrown away.
 *
 * @param {Blob} file
 * @returns {Promise<number>} how many recordings were restored
 */
async function importArchive(file) {
  let entries;
  try {
    ({ entries } = await readZipDirectory(file));
  } catch (error) {
    toaster.show({
      message: t('errors.archiveUnreadable', { message: error?.message ?? '' }),
      tone: 'error',
    });
    return 0;
  }

  const candidates = entries.filter((entry) => ARCHIVE_MIME_TYPES[extensionOf(entry.name)]);
  if (candidates.length === 0) {
    toaster.show({ message: t('errors.archiveEmpty'), tone: 'error' });
    return 0;
  }

  /** @type {Array<{ record: object, blob: Blob }>} */
  const payloads = [];
  let skipped = 0;

  for (const entry of candidates) {
    try {
      const blob = await extractZipEntry(file, entry);
      const checksum = await crc32Blob(blob);
      if (checksum !== entry.crc >>> 0) {
        skipped += 1; // corrupt payload: never store it
        continue;
      }
      const mimeType = ARCHIVE_MIME_TYPES[extensionOf(entry.name)];
      let durationMs = 0;
      try {
        const decoded = await decodeBlob(blob);
        durationMs = Math.round((Number(decoded.duration) || 0) * 1000);
      } catch (error) {
        // Intact audio in a container this browser cannot decode: keep it so it
        // can still be downloaded, but leave the duration unknown.
        console.warn('[restore] duration unavailable', entry.name, error);
      }
      const baseName = String(entry.name).split('/').pop() ?? '';
      payloads.push({
        record: {
          id: createId(),
          name: sanitizeDisplayName(baseName.replace(/\.[^.]+$/, ''), t('recording.untitled')),
          mimeType,
          extension: extensionForMime(mimeType, extensionOf(entry.name)),
          durationMs,
          size: blob.size,
          // Restored recordings sort as the newest, like a fresh import.
          createdAt: Date.now(),
        },
        blob,
      });
    } catch (error) {
      skipped += 1;
      console.warn('[restore] skipped', entry.name, error);
    }
  }

  if (payloads.length > 0) {
    try {
      await repo.restore(payloads);
    } catch (error) {
      // `restore()` writes in one transaction, so nothing was stored: say so
      // instead of leaving an unhandled rejection with no feedback.
      toaster.show({
        message: errorMessage(
          error?.code === 'quota-exceeded' ? 'quotaExceeded' : 'saveFailed',
          '',
        ),
        tone: 'error',
      });
      console.warn('[restore] write failed', error);
      return 0;
    }
  }
  if (skipped > 0) {
    toaster.show({ message: t('toast.restoreSkipped', { count: skipped }), tone: 'error' });
  }
  return payloads.length;
}

/**
 * Import files the user picked: audio files are decoded and stored, ZIP
 * archives are restored entry by entry.
 */
async function importFiles(files) {
  let imported = 0;
  let restored = 0;

  for (const file of files ?? []) {
    if (!file || !file.size) continue;

    if (isArchive(file)) {
      restored += await importArchive(file);
      continue;
    }

    try {
      const decoded = await decodeBlob(file);
      const mimeType = file.type || 'audio/webm';
      const name = sanitizeDisplayName(
        String(file.name ?? '').replace(/\.[^.]+$/, ''),
        t('recording.untitled'),
      );
      await repo.create({
        blob: file,
        name,
        mimeType,
        extension: extensionForMime(mimeType, 'webm'),
        durationMs: Math.round((Number(decoded.duration) || 0) * 1000),
      });
      imported += 1;
    } catch (error) {
      toaster.show({
        message: t('errors.unsupportedFile', { name: file?.name ?? '' }),
        tone: 'error',
      });
      console.warn('[import] failed', file?.name, error);
    }
  }

  if (imported > 0) {
    toaster.show({ message: t('toast.imported', { count: imported }), tone: 'success' });
  }
  if (restored > 0) {
    toaster.show({ message: t('toast.restored', { count: restored }), tone: 'success' });
  }
  if (imported + restored > 0) {
    renderLibrary();
    await refreshStorage();
  }
}

// ------------------------------------------------------- library: dispatch ---

/** Translate a library view intent into an application action. */
async function handleLibraryIntent(intent) {
  switch (intent?.type) {
    case 'query':
      app.query = String(intent.value ?? '');
      app.visible = LIBRARY_PAGE_SIZE;
      renderLibrary();
      break;
    case 'sort':
      // Only the documented orders are accepted, so a stale bookmark or a
      // hand-edited DOM value can never be persisted.
      app.sort = SORT_OPTIONS.includes(intent.value) ? intent.value : 'newest';
      app.settings = saveSettings({ sort: app.sort });
      app.visible = LIBRARY_PAGE_SIZE;
      renderLibrary();
      break;
    case 'showMore':
      app.visible += LIBRARY_PAGE_SIZE;
      renderLibrary();
      break;
    case 'select':
      if (intent.checked) app.selection.add(intent.id);
      else app.selection.delete(intent.id);
      renderLibrary();
      break;
    case 'selectAll':
      app.selection = intent.checked
        ? new Set(repo.list({ query: app.query, sort: app.sort }).map((record) => record.id))
        : new Set();
      renderLibrary();
      break;
    case 'refresh':
      renderLibrary();
      break;
    case 'play':
      await togglePlayback(intent.id);
      break;
    case 'download':
      downloadRecording(intent.id);
      break;
    case 'share':
      await shareRecordingById(intent.id);
      break;
    case 'trim':
      await trimRecording(intent.id);
      break;
    case 'rename':
      await renameRecording(intent.id, intent.name, intent.tags);
      break;
    case 'transcribe':
      await transcribeRecording(intent.id);
      break;
    case 'cancel-transcribe':
      cancelTranscription();
      break;
    case 'save-transcript':
      await saveTranscript(intent.id, intent.text);
      break;
    case 'copy-transcript':
      await copyTranscript(intent.id);
      break;
    case 'download-transcript-txt':
      downloadTranscript(intent.id, 'txt');
      break;
    case 'download-transcript-srt':
      downloadTranscript(intent.id, 'srt');
      break;
    case 'delete-transcript':
      await confirmDeleteTranscript(intent.id);
      break;
    case 'delete':
      abortTranscriptionFor([intent.id]);
      await deleteRecording(intent.id);
      break;
    case 'deleteSelection':
      abortTranscriptionFor(selectedIds());
      await deleteSelection();
      break;
    case 'clearAll':
      abortTranscriptionFor(repo.all().map((record) => record.id));
      await clearAll();
      break;
    case 'zipAll':
      await zipRecordings(repo.list({ query: app.query, sort: app.sort }));
      break;
    case 'zipSelection':
      await zipRecordings(selectedIds().map((id) => repo.get(id)));
      break;
    case 'import':
      await importFiles(intent.files);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------- transcription ---

/** Whether this browser can run the local speech model at all. */
const asrSupported = isAsrSupported();

/**
 * Wait (briefly) for the worker to finish the live preview of the capture the
 * user just stopped, so the real transcription does not bounce off `busy`.
 */
async function waitForTranscriber(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (transcriber?.isBusy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Turn a transcription failure into a localised message (never a raw code). */
function reportAsrError(error) {
  const code = String(error?.code ?? 'asrFailed');
  if (code === 'cancelled') {
    console.info('[asr] transcription cancelled by user');
    toaster.show({ message: t('toast.transcriptionCancelled'), tone: 'info' });
    return;
  }
  if (code === 'busy') {
    toaster.show({ message: t('errors.asrBusy'), tone: 'error' });
    return;
  }
  if (code === 'emptyAudio') {
    toaster.show({ message: t('errors.emptyAudio'), tone: 'error' });
    return;
  }
  console.warn('[asr] transcription failed', error);
  toaster.show({
    message: t('errors.asrFailed', { message: error?.message ?? code }),
    tone: 'error',
  });
}

/**
 * Transcribe one saved recording, on this device.
 *
 * The audio is read back from IndexedDB, decoded to mono float samples and
 * handed to the worker; the finished transcript is stored on the recording and
 * replaces any previous one. Only one transcription runs at a time (the model
 * holds a single ONNX session and the UI has one progress bar).
 *
 * @param {string} id
 */
async function transcribeRecording(id) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  if (!asrSupported || !transcriber) {
    toaster.show({ message: t('errors.asrUnsupported'), tone: 'error' });
    return;
  }
  if (app.transcribingId) {
    toaster.show({ message: t('errors.asrBusy'), tone: 'error' });
    return;
  }

  const job = new AbortController();
  app.transcribingId = id;
  app.transcribeAbort = job;
  libraryView.setTranscribeProgress(id, null, 'load');
  renderLibrary();

  try {
    const blob = await repo.blobFor(id);
    if (!blob || blob.size === 0) {
      throw Object.assign(new Error('empty recording'), { code: 'emptyAudio' });
    }
    const buffer = await decodeBlob(blob);
    const channels = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel));
    }
    const mono = downmixToMono(channels);

    await waitForTranscriber();
    if (job.signal.aborted) {
      throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    }

    const result = await transcriber.transcribe(mono, {
      sampleRate: buffer.sampleRate,
      language: app.settings.asrLanguage,
      signal: job.signal,
      onProgress: ({ stage, fraction }) => libraryView.setTranscribeProgress(id, fraction, stage),
    });

    const transcript = buildTranscript(result, {
      model: ASR_MODEL_LABEL,
      createdAt: Date.now(),
      durationSeconds: result.durationSeconds,
    });
    if (!transcript) {
      // Silence or a skipped decode: report it instead of storing an empty row.
      toaster.show({ message: t('toast.noSpeech', { name: record.name }), tone: 'info' });
      return;
    }

    await repo.setTranscript(id, transcript);
    libraryView.invalidateRow(id);
    toaster.show({ message: t('toast.transcribed', { name: record.name }), tone: 'success' });
  } catch (error) {
    reportAsrError(error);
  } finally {
    app.transcribeAbort = null;
    app.transcribingId = null;
    libraryView.clearTranscribeProgress(id);
    renderLibrary();
  }
}

/** Stop the transcription in progress (its audio and metadata stay untouched). */
function cancelTranscription() {
  app.transcribeAbort?.abort();
}

/**
 * Cancel a running transcription when its recording is about to be deleted,
 * so the worker stops decoding audio nobody will ever see.
 * @param {Iterable<string>} ids
 */
function abortTranscriptionFor(ids) {
  if (!app.transcribingId) return;
  for (const id of ids) {
    if (id === app.transcribingId) {
      cancelTranscription();
      return;
    }
  }
}

/**
 * Start (or restart) the opt-in live caption for the capture that just began.
 *
 * The preview shares the single worker with the real transcription: it only
 * runs while recording, and `handleFinish` stops it before anything else uses
 * the model.
 */
function startLiveCaption() {
  app.liveCaptionActive = Boolean(app.settings.transcribeLive) && asrSupported;
  if (!app.liveCaptionActive || !liveTranscript) return;
  liveTranscript.reset();
  recorderView.setLiveCaption('');
}

/** Stop the live preview and clear its caption. */
function stopLiveCaption() {
  liveTranscript?.stop();
  app.liveCaptionActive = false;
  recorderView?.setLiveCaption('');
}

// ------------------------------------------------------ transcript actions ---

/** Canonical transcript of a recording, or an empty string. */
function transcriptTextFor(id) {
  return formatTranscriptText(repo.get(id)?.transcript);
}

/** `name-2O26-05-04.txt` — the same naming scheme as the audio downloads. */
function transcriptFileName(record, extension) {
  return buildFileName({
    name: sanitizeFileName(record?.name ?? ''),
    extension,
    date: record?.createdAt ? new Date(record.createdAt) : new Date(),
  });
}

/**
 * Export the transcript of a recording as plain text or SubRip subtitles.
 *
 * `.srt` needs the timings that only a machine transcription produces: once the
 * text has been edited by hand the segments no longer describe it, so the
 * button is disabled (`transcript.srtNeedsTimings`) and this is a no-op.
 *
 * @param {string} id
 * @param {'txt'|'srt'} format
 */
function downloadTranscript(id, format) {
  const record = repo.get(id);
  if (!record?.transcript) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  const body =
    format === 'srt'
      ? formatSrt(record.transcript.segments)
      : formatTranscriptText(record.transcript);
  if (!body) {
    toaster.show({
      message: t(format === 'srt' ? 'transcript.srtNeedsTimings' : 'errors.notFound'),
      tone: 'error',
    });
    return;
  }
  downloadBlob(
    new Blob([body], { type: 'text/plain;charset=utf-8' }),
    transcriptFileName(record, format),
  );
  toaster.show({ message: t('toast.downloaded'), tone: 'success' });
}

/** Copy the transcript (edited or not) to the clipboard. */
async function copyTranscript(id) {
  const text = transcriptTextFor(id);
  if (!text) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toaster.show({ message: t('toast.copied'), tone: 'success' });
  } catch (error) {
    console.warn('[transcript] could not copy', error);
    toaster.show({ message: t('toast.copyFailed'), tone: 'error' });
  }
}

/**
 * Store a hand-edited transcript.
 *
 * The user replaces the recognised text wholesale, so the timed segments are
 * dropped: they described the old wording. An empty submission is treated as
 * "remove the transcript", which is what the delete action does too.
 *
 * @param {string} id
 * @param {string} text
 */
async function saveTranscript(id, text) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) {
    await removeTranscript(id);
    return;
  }
  const previous = record.transcript ?? {};
  try {
    await repo.setTranscript(id, {
      ...previous,
      text: clean,
      segments: [],
      edited: true,
      model: previous.model || ASR_MODEL_LABEL,
    });
  } catch (error) {
    toaster.show({
      message: errorMessage(error?.code ?? 'saveFailed', error?.message ?? ''),
      tone: 'error',
    });
    return;
  }
  libraryView.invalidateRow(id);
  renderLibrary();
  toaster.show({ message: t('toast.transcriptSaved'), tone: 'success' });
}

/** Forget the transcript of a recording; the audio is untouched. */
async function removeTranscript(id) {
  if (!repo.get(id)) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  try {
    await repo.setTranscript(id, null);
  } catch (error) {
    toaster.show({
      message: errorMessage(error?.code ?? 'saveFailed', error?.message ?? ''),
      tone: 'error',
    });
    return;
  }
  libraryView.invalidateRow(id);
  renderLibrary();
  toaster.show({ message: t('toast.transcriptDeleted'), tone: 'success' });
}

/** Confirm, then delete the transcript (never the recording). */
async function confirmDeleteTranscript(id) {
  const record = repo.get(id);
  if (!record?.transcript) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  const confirmed = await dialogs.confirm({
    title: t('dialog.deleteTranscriptTitle'),
    body: t('dialog.deleteTranscriptBody', { name: record.name }),
    acceptLabel: t('actions.delete'),
  });
  if (!confirmed) return;
  await removeTranscript(id);
}

// ------------------------------------------------------ settings and chrome ---

/** The storage model the settings view renders (memoised from `app.storage`). */
function storageModel() {
  if (!app.storage) return null;
  return {
    usage: Number(app.storage.usage) || 0,
    quota: Number(app.storage.quota) || 0,
    percent: storagePercent(app.storage),
    level: storageLevel(app.storage),
  };
}

/** Warn once per session when the origin is running out of room. */
function maybeWarnQuota() {
  const level = storageLevel(app.storage);
  if (level === 'ok' || level === 'unknown') {
    if (level === 'ok') app.quotaWarned = false;
    return;
  }
  if (app.quotaWarned) return;
  app.quotaWarned = true;
  const percent = storagePercent(app.storage) ?? 0;
  toaster?.show({
    message:
      level === 'critical'
        ? t('toast.quotaCritical', { percent })
        : t('toast.quotaLow', { percent }),
    tone: level === 'critical' ? 'error' : 'info',
  });
}

/** Re-read the browser's quota estimate and repaint the storage panel. */
async function refreshStorage() {
  try {
    app.storage = await estimateStorage();
  } catch {
    app.storage = null;
  }
  renderSettings();
  maybeWarnQuota();
}

function renderSettings() {
  if (!settingsView || !repo) return;
  settingsView.render(app.settings, {
    stats: repo.stats(),
    storageProtected: app.storageProtected,
    storage: storageModel(),
    topRecordings: topRecordings(repo.all(), 5),
  });
  syncHeaderControls();
  updateFooter();
}

/** Keep the header selects in sync with the stored preferences. */
function syncHeaderControls() {
  const themeSelect = $('#theme-select');
  if (themeSelect) themeSelect.value = app.settings.theme;

  const localeSelect = $('#locale-select');
  if (localeSelect) {
    const codes = SUPPORTED_LOCALES.map((entry) => entry.code);
    localeSelect.value = codes.includes(app.settings.locale) ? app.settings.locale : 'auto';
  }

  setFlag($('#install-btn'), 'hidden', !app.installPrompt);
}

/** Footer year + sponsor credit visibility. */
function updateFooter() {
  const copy = $('#footer-copy');
  if (copy) copy.textContent = t('footer.rights', { year: new Date().getFullYear() });
  setFlag($('#credit-line'), 'hidden', !app.settings.showCredit);
}

/** Persist a preference change coming from the settings form. */
function handleSettingsChange(patch) {
  app.settings = saveSettings(patch);
  if ('theme' in patch) applyTheme(app.settings.theme);
  if ('showCredit' in patch) updateFooter();
  if ('transcribeLive' in patch) {
    // Honour the switch immediately: the caption is a preference, not a
    // per-recording choice, and turning it off must stop the preview now.
    const { mode } = store.getState();
    const capturing = mode === MODES.RECORDING || mode === MODES.PAUSED;
    if (!app.settings.transcribeLive) stopLiveCaption();
    else if (capturing) startLiveCaption();
  }
  renderSettings();
  if ('format' in patch || 'bitrate' in patch) updateFormatHint();
}

/**
 * Pick the locale to use: an explicit choice wins, otherwise the browser wins.
 * @param {string} [preference]
 */
function preferredLocale(preference = app.settings.locale) {
  const explicit = preference && preference !== 'auto' ? [preference] : [];
  const browser = navigator.languages?.length ? navigator.languages : [navigator.language];
  return resolveLocale([...explicit, ...browser]);
}

/** Apply a locale to every label in the document. */
function applyLocale(locale, { announce = false } = {}) {
  app.locale = locale;
  app.t = createTranslator(locale);
  document.documentElement.lang = locale;
  document.title = app.t('app.title');

  translateTree(document, app.t);
  recorderView.relabel();
  conversionView?.relabel();
  libraryView.setStatic();
  settingsView.setStatic();
  updateFormatHint();
  renderLibrary();

  if (announce) toaster.show({ message: t('toast.languageChanged'), tone: 'info' });
}

function handleLocaleChange(value) {
  app.settings = saveSettings({ locale: value });
  applyLocale(preferredLocale(value), { announce: true });
}

function handleThemeChange(value) {
  app.settings = saveSettings({ theme: value });
  applyTheme(app.settings.theme);
  renderSettings();
}

/** Restore every preference to its default. */
function handleSettingsReset() {
  app.settings = resetSettings();
  app.sort = app.settings.sort;
  app.query = '';
  app.visible = LIBRARY_PAGE_SIZE;
  app.selection = new Set();
  applyTheme(app.settings.theme);
  applyLocale(preferredLocale('auto'));
  toaster.show({ message: t('toast.preferencesReset'), tone: 'success' });
}

/** Show the offline badge when the browser reports no connection. */
function syncOnlineState() {
  setFlag($('#offline-badge'), 'hidden', navigator.onLine !== false);
}

/** Ask the browser to keep our data out of automatic eviction. */
async function initStorage() {
  if (!isIndexedDbSupported()) {
    // `dispatch` cannot reach ERROR from IDLE, so patch the store directly.
    store.patch({ mode: MODES.ERROR, error: { code: 'storageUnavailable', message: '' } });
    return;
  }

  try {
    await repo.refresh();
  } catch (error) {
    const code = error?.code === 'quota-exceeded' ? 'quotaExceeded' : 'storageUnavailable';
    toaster.show({ message: errorMessage(code, error?.message ?? ''), tone: 'error' });
    renderLibrary();
    return;
  }

  renderLibrary();

  app.storageProtected = await requestPersistentStorage();
  await refreshStorage();
}

// -------------------------------------------------------------- shortcuts ---

/** Open and reveal the help disclosure. */
function openHelp() {
  const panel = $('#help-panel');
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = true;
  panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  panel.querySelector('summary')?.focus({ preventScroll: true });
}

/** Id of the library row that currently has focus, if any. */
function focusedRowId() {
  const active = document.activeElement;
  const row = active instanceof Element ? active.closest('[data-id]') : null;
  return row?.dataset.id ?? null;
}

/** Global, non-destructive keyboard shortcuts (R, P, Space, Enter, ?). */
function handleShortcut(event) {
  if (event.defaultPrevented || event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditableTarget(event.target)) return;
  if (document.querySelector('dialog[open]')) return;

  const { mode } = store.getState();
  const key = event.key;
  const active = document.activeElement;
  // Never hijack the keys of a focused control (button, link, summary, field…):
  // Space must toggle a checkbox and Enter must press the focused button.
  const onControl =
    active instanceof Element &&
    Boolean(active.closest('button, a, summary, select, input, textarea, [role="button"]'));

  if (key === '?') {
    event.preventDefault();
    openHelp();
    return;
  }

  if (onControl) return;

  if (key === 'r' || key === 'R' || key === ' ') {
    event.preventDefault();
    if (mode === MODES.RECORDING || mode === MODES.PAUSED) handleFinish();
    else handleRequest();
    return;
  }

  if (key === 'p' || key === 'P') {
    if (mode === MODES.RECORDING) {
      event.preventDefault();
      handlePause();
    } else if (mode === MODES.PAUSED) {
      event.preventDefault();
      handleResume();
    }
    return;
  }

  if (key === 'Enter') {
    const id = focusedRowId();
    if (id) {
      event.preventDefault();
      togglePlayback(id);
    }
  }
}

// ------------------------------------------------------- install and update ---

async function handleInstall() {
  const prompt = app.installPrompt;
  if (!prompt) return;
  app.installPrompt = null;
  syncHeaderControls();
  try {
    prompt.prompt();
    await prompt.userChoice;
  } catch (error) {
    console.warn('[install] prompt failed', error);
  }
}

/** Register the service worker and surface update / offline readiness. */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

  try {
    const registration = await navigator.serviceWorker.register('service-worker.js', {
      scope: './',
    });

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toaster.show({
            message: t('misc.updateReady'),
            tone: 'info',
            action: { label: t('misc.reload'), onClick: () => location.reload() },
          });
        }
      });
    });

    if (!navigator.serviceWorker.controller) {
      toaster.show({ message: t('misc.offlineReady'), tone: 'info' });
    }
  } catch (error) {
    console.warn('[sw] registration failed', error);
  }
}

// ------------------------------------------------------------------- boot ---

/** Map a recorder view action onto the matching handler. */
function handleRecorderAction(action) {
  switch (action) {
    case ACTIONS.REQUEST:
      handleRequest();
      break;
    case ACTIONS.PAUSE:
      handlePause();
      break;
    case ACTIONS.RESUME:
      handleResume();
      break;
    case ACTIONS.FINISH:
      handleFinish();
      break;
    case ACTIONS.CANCEL:
      handleCancel();
      break;
    default:
      break;
  }
}

/** The microphone disappeared (unplugged, permission revoked…). */
function handleTrackEnded() {
  const { mode } = store.getState();
  if (mode === MODES.RECORDING || mode === MODES.PAUSED) handleFinish({ reason: 'track-ended' });
}

/** Create the collaborators, wire the UI and load persisted data. */
async function init() {
  toaster = createToaster($('#toast-host'), {
    labels: { dismiss: app.t('actions.close') },
  });
  store = createStore();
  repo = createRepository();
  dialogs = createDialogs({ t });
  conversionView = createConversionView({ t, onCancel: cancelConversion });

  recorderView = createRecorderView({
    t,
    onAction: handleRecorderAction,
    onRetry: handleRequest,
  });
  libraryView = createLibraryView({
    t,
    canShare: typeof navigator.canShare === 'function',
    onAction: handleLibraryIntent,
  });
  settingsView = createSettingsView({
    t,
    isTypeSupported,
    mp3EncoderAvailable: MP3_ENCODER_AVAILABLE,
    asrSupported,
    asrModelLabel: ASR_MODEL_LABEL,
    asrModelBytes: ASR_MODEL_BYTES,
    onChange: handleSettingsChange,
    onReset: handleSettingsReset,
  });
  // The worker is only *spawned* on the first transcription; creating the
  // client here keeps `isBusy`/`dispose` available to the rest of the wiring.
  transcriber = createTranscriber();
  liveTranscript = createLiveTranscript({
    transcribe: (samples, { sampleRate }) => {
      if (!transcriber) return Promise.reject(new Error('Transcription is unavailable'));
      return transcriber.transcribe(samples, {
        sampleRate,
        language: app.settings.asrLanguage,
      });
    },
    onUpdate: ({ text }) => {
      if (!app.liveCaptionActive) return;
      recorderView.setLiveCaption(text);
    },
    onError: () => {
      // A preview is a bonus: a failed slice must never disturb the capture.
      app.liveCaptionActive = false;
      recorderView.setLiveCaption('');
    },
  });
  recorder = createRecorder({
    onLevel: ({ level }) => recorderView.setLevel(level),
    onTick: (elapsed) => recorderView.setElapsed(elapsed),
    onTrackEnded: handleTrackEnded,
    onAudio: (samples, sampleRate) => {
      if (!app.liveCaptionActive) return;
      liveTranscript?.push(samples, sampleRate);
    },
  });

  // The state machine is the only thing that drives the recorder panel.
  store.subscribe((state) => {
    recorderView.render(state.mode, { error: state.error });
  });
  recorderView.render(store.getState().mode);

  // Preview player events keep the row icons and the store in sync.
  const audio = previewAudio();
  if (audio) {
    audio.addEventListener('play', () => {
      app.playing = true;
      store.setPlayback(PLAYBACK.PLAYING);
      renderLibrary();
    });
    audio.addEventListener('pause', () => {
      if (!app.playing) return;
      app.playing = false;
      store.setPlayback(PLAYBACK.PAUSED);
      renderLibrary();
    });
    audio.addEventListener('ended', () => {
      app.playing = false;
      store.setPlayback(PLAYBACK.IDLE);
      renderLibrary();
    });
  }

  $('#theme-select')?.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement) handleThemeChange(event.target.value);
  });
  $('#locale-select')?.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement) handleLocaleChange(event.target.value);
  });
  $('#install-btn')?.addEventListener('click', () => handleInstall());

  window.addEventListener('online', syncOnlineState);
  window.addEventListener('offline', syncOnlineState);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    app.installPrompt = event;
    syncHeaderControls();
  });
  window.addEventListener('appinstalled', () => {
    app.installPrompt = null;
    syncHeaderControls();
  });
  window.addEventListener('pagehide', () => {
    recorder.cancel();
    cancelConversion();
    stopLiveCaption();
    cancelTranscription();
    transcriber?.dispose();
  });
  document.addEventListener('keydown', handleShortcut);

  applyTheme(app.settings.theme);
  app.sort = app.settings.sort;
  // A format saved on another browser may not exist here (see the helper).
  reconcileFormatPreference();

  recorderView.setStatic();
  settingsView.setStatic();
  libraryView.setStatic();

  applyLocale(preferredLocale());
  syncOnlineState();

  await initStorage();
  registerServiceWorker();
}

init().catch((error) => {
  console.error('[init] failed', error);
  const message = $('#error-message');
  if (message) message.textContent = errorMessage(error?.code ?? 'unknown', error?.message ?? '');
  setFlag($('#error-panel'), 'hidden', false);
});
