import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS,
  MODES,
  PLAYBACK,
  TRANSITIONS,
  canTransition,
  createInitialState,
  createStore,
  getControls,
  nextMode,
  statusKeyForMode,
} from '../../scripts/modules/state.js';

test('a full record / pause / resume / finish / save cycle is allowed', () => {
  const steps = [
    [MODES.IDLE, ACTIONS.REQUEST, MODES.REQUESTING],
    [MODES.REQUESTING, ACTIONS.START, MODES.RECORDING],
    [MODES.RECORDING, ACTIONS.PAUSE, MODES.PAUSED],
    [MODES.PAUSED, ACTIONS.RESUME, MODES.RECORDING],
    [MODES.RECORDING, ACTIONS.FINISH, MODES.PROCESSING],
    [MODES.PROCESSING, ACTIONS.COMPLETE, MODES.READY],
    [MODES.READY, ACTIONS.REQUEST, MODES.REQUESTING],
  ];
  for (const [from, action, expected] of steps) {
    assert.equal(nextMode(from, action), expected, `${from} --${action}--> ${expected}`);
  }
});

test('invalid transitions are rejected', () => {
  assert.equal(nextMode(MODES.IDLE, ACTIONS.PAUSE), null);
  assert.equal(nextMode(MODES.IDLE, ACTIONS.FINISH), null);
  assert.equal(nextMode(MODES.RECORDING, ACTIONS.REQUEST), null);
  assert.equal(nextMode(MODES.PROCESSING, ACTIONS.PAUSE), null);
  assert.equal(canTransition('nonsense', ACTIONS.START), false);
  assert.equal(canTransition(MODES.IDLE, 'nonsense'), false);
});

test('every mode has a defined transition table entry', () => {
  for (const mode of Object.values(MODES)) {
    assert.ok(TRANSITIONS[mode], `missing transitions for ${mode}`);
    assert.ok(Object.keys(TRANSITIONS[mode]).length > 0);
  }
});

test('getControls exposes exactly one primary action per mode', () => {
  assert.deepEqual(getControls(MODES.IDLE), {
    record: true,
    pause: false,
    resume: false,
    stop: false,
    busy: false,
  });
  assert.deepEqual(getControls(MODES.RECORDING), {
    record: false,
    pause: true,
    resume: false,
    stop: true,
    busy: false,
  });
  assert.deepEqual(getControls(MODES.PAUSED), {
    record: false,
    pause: false,
    resume: true,
    stop: true,
    busy: false,
  });
  assert.deepEqual(getControls(MODES.PROCESSING), {
    record: false,
    pause: false,
    resume: false,
    stop: false,
    busy: true,
  });
  assert.equal(getControls(MODES.READY).record, true);
  assert.equal(getControls(MODES.ERROR).record, true);
  assert.equal(getControls(MODES.REQUESTING).busy, true);
});

test('statusKeyForMode maps to i18n keys', () => {
  assert.equal(statusKeyForMode(MODES.RECORDING), 'status.recording');
  assert.equal(statusKeyForMode(MODES.ERROR), 'status.error');
  assert.equal(statusKeyForMode('other'), 'status.idle');
});

test('store dispatches, notifies subscribers and ignores invalid actions', () => {
  const store = createStore();
  const events = [];
  const unsubscribe = store.subscribe((state, meta) => events.push([state.mode, meta.action]));

  assert.equal(store.dispatch(ACTIONS.PAUSE), false, 'pause from idle must be rejected');
  assert.equal(store.getState().mode, MODES.IDLE);
  assert.equal(events.length, 0, 'rejected actions must not notify');

  assert.equal(store.dispatch(ACTIONS.REQUEST), true);
  assert.equal(store.dispatch(ACTIONS.START), true);
  assert.deepEqual(events, [
    [MODES.REQUESTING, ACTIONS.REQUEST],
    [MODES.RECORDING, ACTIONS.START],
  ]);

  store.dispatch(ACTIONS.FAIL, { code: 'micDenied', message: 'nope' });
  assert.equal(store.getState().mode, MODES.ERROR);
  assert.deepEqual(store.getState().error, { code: 'micDenied', message: 'nope' });

  store.dispatch(ACTIONS.REQUEST);
  assert.equal(store.getState().error, null, 'retry clears the previous error');

  unsubscribe();
  store.dispatch(ACTIONS.START);
  assert.equal(events.length, 4, 'unsubscribed listeners are not called');
});

test('store accepts plain string errors and tracks playback separately', () => {
  const store = createStore();
  store.dispatch(ACTIONS.REQUEST);
  store.dispatch(ACTIONS.FAIL, 'boom');
  assert.deepEqual(store.getState().error, { code: 'error', message: 'boom' });

  store.setPlayback(PLAYBACK.PLAYING);
  assert.equal(store.getState().playback, PLAYBACK.PLAYING);
  store.setPlayback('nonsense');
  assert.equal(store.getState().playback, PLAYBACK.PLAYING, 'invalid playback state ignored');
  store.setPlayback(PLAYBACK.PAUSED);
  assert.equal(store.getState().playback, PLAYBACK.PAUSED);
});

test('store reset restores the initial state and notifies', () => {
  const store = createStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.dispatch(ACTIONS.REQUEST);
  store.dispatch(ACTIONS.START);
  store.setPlayback(PLAYBACK.PLAYING);
  store.reset();
  assert.deepEqual(store.getState(), createInitialState());
  assert.equal(notifications, 4);
});

test('a throwing subscriber cannot break the state machine', () => {
  const store = createStore();
  const originalError = console.error;
  console.error = () => {};
  try {
    store.subscribe(() => {
      throw new Error('listener exploded');
    });
    assert.equal(store.dispatch(ACTIONS.REQUEST), true);
    assert.equal(store.getState().mode, MODES.REQUESTING);
  } finally {
    console.error = originalError;
  }
});

test('patch merges extra fields without touching the mode', () => {
  const store = createStore();
  store.patch({ supported: false });
  assert.equal(store.getState().mode, MODES.IDLE);
  assert.equal(store.getState().supported, false);
});
