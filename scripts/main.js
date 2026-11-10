/**
 * Application orchestrator.
 *
 * This is the only module that knows about *everything*: it owns the state
 * machine, the IndexedDB repository, the recorder engine, the views and the
 * service worker. Each collaborator stays small and testable; wiring lives here.
 */

import {
  analyzeWaveform,
  convertToWav,
  decodeBlob,
  downloadBlob,
  shareRecording,
  trimToWav,
} from './modules/audio-utils.js';
import { estimateStorage, isIndexedDbSupported, requestPersistentStorage } from './modules/db.js';
import { createDialogs } from './modules/dialogs.js';
import { $, isEditableTarget, setFlag, translateTree } from './modules/dom.js';
import { buildFileName, timestampForFilename } from './modules/format.js';
import { createTranslator, resolveLocale, SUPPORTED_LOCALES } from './modules/i18n.js';
import { createLibraryView } from './modules/library-view.js';
import { extensionForMime, resolveFormat } from './modules/mime.js';
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
import { createRepository } from './modules/store.js';
import { createToaster } from './modules/toast.js';
import { createZip, dedupeNames } from './modules/zip.js';

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
  /** @type {Set<string>} ids selected in the library */
  selection: new Set(),
  /** @type {string|null} recording currently loaded in the preview player */
  activeId: null,
  playing: false,
  storageProtected: null,
  /** object URL of the preview player, revoked when it changes */
  objectUrl: null,
  installPrompt: null,
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

/** Bound translator: always reads the current locale. */
const t = (key, params) => app.t(key, params);

/** Resolve an error code to a localised message (never returns a raw key). */
function errorMessage(code, message = '') {
  const key = `errors.${code}`;
  const text = t(key, { message });
  return text === key ? t('errors.unknown', { message: message || code }) : text;
}

// ---------------------------------------------------------------- recorder ---

/** Resolve the current format preference against browser capabilities. */
function currentPlan() {
  return resolveFormat(app.settings.format, isTypeSupported);
}

/** Show "Will record as …" above the timer. */
function updateFormatHint() {
  app.plan = currentPlan();
  recorderView.setFormatHint(t('misc.formatHint', { format: app.plan.label }));
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
  app.plan = plan;
  recorderView.setElapsed(0);

  try {
    const { trackSettings } = await recorder.start({
      captureMimeType: plan.captureMimeType,
      // WAV is encoded after capture, so a bitrate would only waste CPU.
      bitrate: plan.conversion === 'wav' ? undefined : app.settings.bitrate,
      constraints: buildAudioConstraints(app.settings),
    });
    store.dispatch(ACTIONS.START);
    recorderView.setFormatHint(t('misc.formatHint', { format: plan.label }));
    recorderView.setMicrophoneHint(trackSettings);
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
  try {
    const { blob, mimeType, durationMs } = await recorder.stop();
    const plan = app.plan ?? currentPlan();

    let outputBlob = blob;
    let outputMime = mimeType || plan.outputMimeType || 'audio/webm';
    let extension = extensionForMime(outputMime, plan.extension || 'webm');

    if (plan.conversion === 'wav') {
      try {
        outputBlob = await convertToWav(blob);
        outputMime = 'audio/wav';
        extension = 'wav';
      } catch (error) {
        throw Object.assign(new Error(error?.message ?? 'conversion failed'), {
          code: 'conversionFailed',
        });
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
  } catch (error) {
    reportError(error, 'saveFailed');
  }
}

/** Abort the recording in progress without saving anything. */
function handleCancel() {
  recorder.cancel();
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
    if (app.objectUrl) URL.revokeObjectURL(app.objectUrl);
    app.objectUrl = URL.createObjectURL(record.blob);
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
  const total = repo.all().length;
  libraryView.render({
    records: repo.list({ query: app.query, sort: app.sort }),
    total,
    query: app.query,
    sort: app.sort,
    selection: app.selection,
    activeId: app.activeId,
    playing: app.playing,
    locale: app.locale,
  });
  renderSettings();
}

// ------------------------------------------------------- library: actions ---

function downloadRecording(id) {
  const record = repo.get(id);
  if (!record) {
    toaster.show({ message: t('errors.notFound'), tone: 'error' });
    return;
  }
  downloadBlob(
    record.blob,
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
  const result = await shareRecording(
    record.blob,
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

  let analysis;
  try {
    analysis = await analyzeWaveform(record.blob, 240);
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

  try {
    const { blob, duration: trimmedSeconds } = await trimToWav(
      record.blob,
      range.startSeconds,
      range.endSeconds,
    );
    const name = `${record.name || t('recording.untitled')} (${t('recording.trimmed')})`;
    const created = await repo.create({
      blob,
      name,
      mimeType: 'audio/wav',
      extension: 'wav',
      durationMs: Math.round(trimmedSeconds * 1000),
      sourceId: record.id,
      trimmed: true,
    });
    toaster.show({ message: t('toast.trimmed', { name: created.name }), tone: 'success' });
    renderLibrary();
  } catch (error) {
    toaster.show({
      message: t('errors.trimFailed', { message: error?.message ?? '' }),
      tone: 'error',
    });
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

  let removed = 0;
  for (const id of ids) {
    try {
      await repo.remove(id);
      removed += 1;
    } catch {
      /* keep going: one failure must not block the rest */
    }
    app.selection.delete(id);
    if (app.activeId === id) stopPlayback();
  }
  toaster.show({ message: t('toast.deletedAll', { count: removed }), tone: 'success' });
  renderLibrary();
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
}

/** Bundle the given recordings into a single ZIP download. */
async function zipRecordings(records) {
  const list = (records ?? []).filter((record) => record?.blob);
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
    const entries = [];
    for (const [index, record] of list.entries()) {
      const data = new Uint8Array(await record.blob.arrayBuffer());
      entries.push({ name: names[index], data });
    }
    const zip = createZip(entries, { date: new Date() });
    downloadBlob(
      new Blob([zip], { type: 'application/zip' }),
      `audio-recordings_${timestampForFilename()}.zip`,
    );
    toaster.show({ message: t('toast.zipped', { count: list.length }), tone: 'success' });
  } catch {
    toaster.show({ message: t('errors.zipFailed'), tone: 'error' });
  }
}

/** Import files the user picked, verifying each one can be decoded. */
async function importFiles(files) {
  let imported = 0;
  for (const file of files ?? []) {
    if (!file || !file.size) continue;
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
    renderLibrary();
  }
}

// ------------------------------------------------------- library: dispatch ---

/** Translate a library view intent into an application action. */
async function handleLibraryIntent(intent) {
  switch (intent?.type) {
    case 'query':
      app.query = String(intent.value ?? '');
      renderLibrary();
      break;
    case 'sort':
      app.sort = String(intent.value ?? 'newest');
      app.settings = saveSettings({ sort: app.sort });
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
    case 'delete':
      await deleteRecording(intent.id);
      break;
    case 'deleteSelection':
      await deleteSelection();
      break;
    case 'clearAll':
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

// ------------------------------------------------------ settings and chrome ---

/** Re-render the preferences panel, header controls and footer. */
function renderSettings() {
  if (!settingsView || !repo) return;
  settingsView.render(app.settings, {
    stats: repo.stats(),
    storageProtected: app.storageProtected,
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
    return;
  }

  renderLibrary();

  app.storageProtected = await requestPersistentStorage();
  renderSettings();

  const estimate = await estimateStorage();
  if (estimate?.quota && estimate.usage / estimate.quota > 0.9) {
    toaster.show({ message: t('errors.quotaExceeded'), tone: 'error' });
  }
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
  // Never hijack Space/Enter from a focused control (button, link, summary…).
  const onControl =
    active instanceof Element &&
    Boolean(active.closest('button, a, summary, select, [role="button"]'));

  if (key === '?') {
    event.preventDefault();
    openHelp();
    return;
  }

  if (key === 'r' || key === 'R' || (key === ' ' && !onControl)) {
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

  if (key === 'Enter' && !onControl) {
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
    onChange: handleSettingsChange,
    onReset: handleSettingsReset,
  });
  recorder = createRecorder({
    onLevel: ({ level }) => recorderView.setLevel(level),
    onTick: (elapsed) => recorderView.setElapsed(elapsed),
    onTrackEnded: handleTrackEnded,
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
  window.addEventListener('pagehide', () => recorder.cancel());
  document.addEventListener('keydown', handleShortcut);

  applyTheme(app.settings.theme);
  app.sort = app.settings.sort;

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
