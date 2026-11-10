/**
 * Single source of truth for recorder + playback state.
 *
 * The original app toggled button visibility ad hoc, which allowed impossible
 * situations (e.g. "stop" clickable while idle). Every user action now goes
 * through `dispatch()` which validates the transition, so a stray click or a
 * late MediaRecorder callback can never corrupt the UI.
 */

/** Recorder lifecycle. */
export const MODES = Object.freeze({
  IDLE: 'idle',
  REQUESTING: 'requesting',
  RECORDING: 'recording',
  PAUSED: 'paused',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
});

/** Playback lifecycle of the preview player (independent from recording). */
export const PLAYBACK = Object.freeze({
  IDLE: 'idle',
  PLAYING: 'playing',
  PAUSED: 'paused',
});

/**
 * Allowed transitions: from -> action -> to.
 * Anything not listed here is rejected by `dispatch()`.
 */
export const TRANSITIONS = Object.freeze({
  [MODES.IDLE]: { request: MODES.REQUESTING },
  [MODES.REQUESTING]: {
    start: MODES.RECORDING,
    fail: MODES.ERROR,
    cancel: MODES.IDLE,
  },
  [MODES.RECORDING]: {
    pause: MODES.PAUSED,
    finish: MODES.PROCESSING,
    cancel: MODES.IDLE,
    fail: MODES.ERROR,
  },
  [MODES.PAUSED]: {
    resume: MODES.RECORDING,
    finish: MODES.PROCESSING,
    cancel: MODES.IDLE,
    fail: MODES.ERROR,
  },
  [MODES.PROCESSING]: {
    complete: MODES.READY,
    fail: MODES.ERROR,
    cancel: MODES.IDLE,
  },
  [MODES.READY]: {
    request: MODES.REQUESTING,
    trim: MODES.PROCESSING,
    reset: MODES.IDLE,
  },
  [MODES.ERROR]: {
    request: MODES.REQUESTING,
    reset: MODES.IDLE,
  },
});

/** Actions understood by the store. */
export const ACTIONS = Object.freeze({
  REQUEST: 'request',
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  FINISH: 'finish',
  COMPLETE: 'complete',
  FAIL: 'fail',
  CANCEL: 'cancel',
  RESET: 'reset',
  TRIM: 'trim',
});

/**
 * @param {string} mode
 * @param {string} action
 * @returns {boolean}
 */
export function canTransition(mode, action) {
  const targets = TRANSITIONS[mode];
  return Boolean(targets && Object.prototype.hasOwnProperty.call(targets, action));
}

/**
 * @param {string} mode
 * @param {string} action
 * @returns {string|null} next mode, or null when the transition is invalid
 */
export function nextMode(mode, action) {
  const targets = TRANSITIONS[mode];
  if (!targets) return null;
  return targets[action] ?? null;
}

/**
 * Which primary controls should be enabled for a given mode.
 * Used by the UI so accessibility (disabled) always matches the state model.
 *
 * @param {string} mode
 * @returns {{ record: boolean, pause: boolean, resume: boolean, stop: boolean, busy: boolean }}
 */
export function getControls(mode) {
  return {
    record: mode === MODES.IDLE || mode === MODES.READY || mode === MODES.ERROR,
    pause: mode === MODES.RECORDING,
    resume: mode === MODES.PAUSED,
    stop: mode === MODES.RECORDING || mode === MODES.PAUSED,
    busy: mode === MODES.REQUESTING || mode === MODES.PROCESSING,
  };
}

/** i18n key describing the current mode. */
export function statusKeyForMode(mode) {
  switch (mode) {
    case MODES.REQUESTING:
      return 'status.requesting';
    case MODES.RECORDING:
      return 'status.recording';
    case MODES.PAUSED:
      return 'status.paused';
    case MODES.PROCESSING:
      return 'status.processing';
    case MODES.READY:
      return 'status.ready';
    case MODES.ERROR:
      return 'status.error';
    default:
      return 'status.idle';
  }
}

/** @returns {{ mode: string, playback: string, error: { code: string, message: string }|null }} */
export function createInitialState() {
  return { mode: MODES.IDLE, playback: PLAYBACK.IDLE, error: null };
}

/**
 * Tiny observable store. No framework, ~50 lines, easily unit tested.
 *
 * @param {object} [initialState]
 * @returns {{
 *   getState: () => any,
 *   subscribe: (listener: (state: any, meta: object) => void) => () => void,
 *   dispatch: (action: string, payload?: any) => boolean,
 *   setPlayback: (playback: string) => void,
 *   patch: (partial: object, meta?: object) => void,
 *   reset: () => void,
 * }}
 */
export function createStore(initialState = createInitialState()) {
  let state = { ...initialState };
  const listeners = new Set();

  const notify = (meta = {}) => {
    const snapshot = { ...state };
    for (const listener of listeners) {
      try {
        listener(snapshot, meta);
      } catch (error) {
        // A broken listener must never break the state machine.
        console.error('[state] listener failed', error);
      }
    }
  };

  return {
    getState: () => ({ ...state }),

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Apply a recorder action. Returns false (and changes nothing) when the
     * transition is not allowed from the current mode.
     */
    dispatch(action, payload) {
      const target = nextMode(state.mode, action);
      if (!target) {
        return false;
      }
      const error =
        action === ACTIONS.FAIL
          ? typeof payload === 'string'
            ? { code: 'error', message: payload }
            : (payload ?? state.error ?? { code: 'unknown', message: 'Unknown error' })
          : null;
      state = { ...state, mode: target, error };
      notify({ action, payload });
      return true;
    },

    setPlayback(playback) {
      if (!Object.values(PLAYBACK).includes(playback) || state.playback === playback) return;
      state = { ...state, playback };
      notify({ action: 'playback', payload: playback });
    },

    patch(partial, meta = {}) {
      state = { ...state, ...partial };
      notify(meta);
    },

    reset() {
      state = createInitialState();
      notify({ action: 'reset' });
    },
  };
}
