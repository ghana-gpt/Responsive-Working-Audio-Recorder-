import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SORT_LONGEST,
  SORT_NAME,
  SORT_NEWEST,
  SORT_OLDEST,
  SORT_OPTIONS,
  buildRecording,
  computeStats,
  filterRecordings,
  findRecording,
  nextDefaultName,
  sortRecordings,
} from '../../scripts/modules/library.js';

const records = [
  {
    id: 'a',
    name: 'Meeting notes',
    tags: ['work', 'Monday'],
    durationMs: 60_000,
    size: 100,
    createdAt: 300,
  },
  { id: 'b', name: 'Idea', tags: ['idea'], durationMs: 5_000, size: 50, createdAt: 100 },
  { id: 'c', name: 'Réunion', tags: [], durationMs: 10_000, size: 70, createdAt: 200 },
];

test('filterRecordings matches names and tags case-insensitively', () => {
  assert.equal(filterRecordings(records, 'meeting').length, 1);
  assert.equal(filterRecordings(records, 'MEETING').length, 1);
  assert.equal(filterRecordings(records, 'work').length, 1, 'matches tags');
  assert.equal(filterRecordings(records, 'réu').length, 1, 'matches accents');
  assert.equal(filterRecordings(records, 'nope').length, 0);
  assert.equal(filterRecordings(records, '   ').length, 3);
  assert.equal(filterRecordings(records, '').length, 3);
  assert.equal(filterRecordings(null, '').length, 0);
});

test('filterRecordings returns a copy so callers cannot mutate the source', () => {
  const result = filterRecordings(records, '');
  result.pop();
  assert.equal(records.length, 3);
});

test('sortRecordings supports every documented order', () => {
  assert.deepEqual(
    sortRecordings(records, SORT_NEWEST).map((r) => r.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    sortRecordings(records, SORT_OLDEST).map((r) => r.id),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    sortRecordings(records, SORT_LONGEST).map((r) => r.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    sortRecordings(records, SORT_NAME).map((r) => r.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    sortRecordings(records, 'unknown').map((r) => r.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(SORT_OPTIONS.length, 4);
});

test('sortRecordings does not mutate the input array', () => {
  const input = records.slice();
  sortRecordings(input, SORT_NAME);
  assert.deepEqual(
    input.map((r) => r.id),
    ['a', 'b', 'c'],
  );
});

test('computeStats aggregates count, duration, size and newest timestamp', () => {
  const stats = computeStats(records);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalDurationMs, 75_000);
  assert.equal(stats.totalBytes, 220);
  assert.equal(stats.newestAt, 300);
  assert.deepEqual(computeStats([]), {
    count: 0,
    totalDurationMs: 0,
    totalBytes: 0,
    newestAt: null,
  });
  assert.deepEqual(computeStats(undefined), {
    count: 0,
    totalDurationMs: 0,
    totalBytes: 0,
    newestAt: null,
  });
});

test('findRecording locates by id', () => {
  assert.equal(findRecording(records, 'b').name, 'Idea');
  assert.equal(findRecording(records, 'zzz'), undefined);
  assert.equal(findRecording(undefined, 'a'), undefined);
});

test('nextDefaultName avoids collisions', () => {
  assert.equal(nextDefaultName([], 'Recording'), 'Recording 1');
  assert.equal(
    nextDefaultName([{ name: 'Recording 1' }, { name: 'Recording 2' }], 'Recording'),
    'Recording 3',
  );
  assert.equal(nextDefaultName([{ name: 'Recording 7' }], 'Recording'), 'Recording 8');
  assert.equal(
    nextDefaultName([{ name: 'Enregistrement 2' }], 'Enregistrement'),
    'Enregistrement 3',
  );
  // a gap in the numbering is still skipped safely
  assert.equal(
    nextDefaultName([{ name: 'Recording 1' }, { name: 'Recording 3' }], 'Recording'),
    'Recording 4',
  );
});

test('buildRecording normalises the persisted shape', () => {
  const blob = new Blob(['abc'], { type: 'audio/webm' });
  const record = buildRecording({
    id: 42,
    name: '  Weekly sync  ',
    tags: ['work', 'work'],
    blob,
    durationMs: 1234.6,
    createdAt: 1000,
  });
  assert.equal(record.id, '42');
  assert.equal(record.name, 'Weekly sync');
  assert.deepEqual(record.tags, ['work', 'work'], 'de-duplication happens at input time');
  assert.equal(record.durationMs, 1235);
  assert.equal(record.size, 3, 'falls back to blob.size');
  assert.equal(record.mimeType, 'audio/webm');
  assert.equal(record.extension, 'webm');
  assert.equal(record.createdAt, 1000);
  assert.equal(record.updatedAt, 1000);
  assert.equal(record.sourceId, null);
  assert.equal(record.trimmed, false);
});

test('buildRecording rejects incomplete records', () => {
  assert.throws(() => buildRecording({ blob: new Blob(['a']) }), /requires an id/);
  assert.throws(() => buildRecording({ id: 'x' }), /requires a Blob/);
  assert.throws(() => buildRecording(undefined), /requires an id/);
});
