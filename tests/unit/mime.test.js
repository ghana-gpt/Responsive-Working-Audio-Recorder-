import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMAT_OPTIONS,
  RECORDER_CANDIDATES,
  baseMimeType,
  describeMimeType,
  extensionForMime,
  formatAvailability,
  listSupportedCandidates,
  pickCaptureCandidate,
  resolveFormat,
} from '../../scripts/modules/mime.js';

/** Fake capability probe for a Chrome-like browser. */
const chrome = (type) => ['audio/webm;codecs=opus', 'audio/webm'].includes(type);
/** Fake capability probe for Safari. */
const safari = (type) => type === 'audio/mp4';
/** Fake probe for Firefox. */
const firefox = (type) => ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm'].includes(type);
const nothing = () => false;
const everything = () => true;

test('baseMimeType strips codec parameters', () => {
  assert.equal(baseMimeType('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(baseMimeType('  AUDIO/MP4 '), 'audio/mp4');
  assert.equal(baseMimeType(undefined), '');
});

test('extensionForMime maps containers to useful extensions', () => {
  assert.equal(extensionForMime('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionForMime('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(extensionForMime('audio/mp4'), 'm4a');
  assert.equal(extensionForMime('audio/aac'), 'aac');
  assert.equal(extensionForMime('audio/wav'), 'wav');
  assert.equal(extensionForMime('audio/mpeg'), 'mp3');
  assert.equal(extensionForMime('audio/unknown', 'bin'), 'bin');
});

test('describeMimeType is human readable', () => {
  assert.equal(describeMimeType('audio/webm;codecs=opus'), 'WebM / Opus');
  assert.equal(describeMimeType('audio/mp4'), 'MP4 (AAC)');
  assert.equal(describeMimeType('audio/ogg'), 'OGG');
  assert.equal(describeMimeType(''), 'Audio');
});

test('listSupportedCandidates honours the capability probe, best first', () => {
  assert.deepEqual(
    listSupportedCandidates(chrome).map((c) => c.mimeType),
    ['audio/webm;codecs=opus', 'audio/webm'],
  );
  assert.deepEqual(
    listSupportedCandidates(safari).map((c) => c.mimeType),
    ['audio/mp4'],
  );
  assert.deepEqual(listSupportedCandidates(nothing), []);
  assert.equal(listSupportedCandidates(everything).length, RECORDER_CANDIDATES.length);
});

test('a probe that throws is treated as unsupported', () => {
  const throwing = () => {
    throw new Error('boom');
  };
  assert.deepEqual(listSupportedCandidates(throwing), []);
});

test('pickCaptureCandidate prefers the requested family when available', () => {
  assert.equal(pickCaptureCandidate('auto', firefox).mimeType, 'audio/webm');
  assert.equal(pickCaptureCandidate('ogg', firefox).mimeType, 'audio/ogg;codecs=opus');
  assert.equal(pickCaptureCandidate('webm', firefox).mimeType, 'audio/webm');
  assert.equal(pickCaptureCandidate('ogg', chrome), null);
  assert.equal(pickCaptureCandidate('wav', safari).mimeType, 'audio/mp4');
  assert.equal(pickCaptureCandidate(null, nothing), null);
});

test('resolveFormat auto picks the best available container', () => {
  const plan = resolveFormat('auto', chrome);
  assert.equal(plan.supported, true);
  assert.equal(plan.captureMimeType, 'audio/webm;codecs=opus');
  assert.equal(plan.outputMimeType, 'audio/webm;codecs=opus');
  assert.equal(plan.extension, 'webm');
  assert.equal(plan.conversion, null);
  assert.equal(plan.reason, null);
});

test('resolveFormat WAV converts after capturing a supported container', () => {
  const plan = resolveFormat('wav', safari);
  assert.equal(plan.supported, true);
  assert.equal(plan.captureMimeType, 'audio/mp4');
  assert.equal(plan.outputMimeType, 'audio/wav');
  assert.equal(plan.extension, 'wav');
  assert.equal(plan.conversion, 'wav');
});

test('resolveFormat reports reasons for unavailable formats', () => {
  assert.equal(resolveFormat('ogg', chrome).reason, 'unsupported');
  assert.equal(resolveFormat('mp3', everything).supported, true); // hypothetical encoder-capable browser
  assert.equal(resolveFormat('mp3', chrome).reason, 'needs-encoder');
  assert.equal(resolveFormat('mp3', chrome).supported, false);

  const noRecorder = resolveFormat('auto', nothing);
  assert.equal(noRecorder.supported, false);
  assert.equal(noRecorder.reason, 'no-recorder');
  assert.equal(noRecorder.captureMimeType, null);
});

test('resolveFormat falls back to auto for unknown ids', () => {
  const plan = resolveFormat('nonsense', chrome);
  assert.equal(plan.requestedId, 'auto');
  assert.equal(plan.supported, true);
});

test('formatAvailability lists every option', () => {
  const availability = formatAvailability(chrome);
  assert.deepEqual(Object.keys(availability).sort(), FORMAT_OPTIONS.map((o) => o.id).sort());
  assert.equal(availability.webm.available, true);
  assert.equal(availability.ogg.available, false);
  assert.equal(availability.wav.available, true);
  assert.equal(availability.mp3.available, false);
  assert.equal(availability.mp3.reason, 'needs-encoder');
  assert.equal(formatAvailability(nothing).auto.reason, 'no-recorder');
});
