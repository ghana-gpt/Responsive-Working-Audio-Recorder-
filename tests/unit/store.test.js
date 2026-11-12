import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StorageError } from '../../scripts/modules/db.js';
import { createId, createRepository } from '../../scripts/modules/store.js';

/** Fake IndexedDB layer with the same async surface as modules/db.js. */
function fakeDb(initial = []) {
  const records = new Map();
  const blobs = new Map();
  const calls = [];
  const db = {
    records,
    blobs,
    calls,
    failPutMany: false,
    async getAll() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    async put(record, blob) {
      calls.push(['put', record.id, blob]);
      records.set(record.id, { ...record });
      if (blob) blobs.set(record.id, blob);
      return record;
    },
    async putMany(entries) {
      if (db.failPutMany) throw new StorageError('quota-exceeded', 'full');
      calls.push(['putMany', entries.length]);
      for (const { record, blob } of entries) {
        records.set(record.id, { ...record });
        if (blob) blobs.set(record.id, blob);
      }
      return entries.length;
    },
    async remove(id) {
      records.delete(id);
      blobs.delete(id);
    },
    async removeMany(ids) {
      for (const id of ids) {
        records.delete(id);
        blobs.delete(id);
      }
    },
    async clear() {
      records.clear();
      blobs.clear();
    },
    async getBlob(id) {
      return blobs.get(id) ?? null;
    },
  };
  for (const record of initial) records.set(record.id, { ...record });
  return db;
}

/** Deterministic id factory so assertions stay readable. */
function ids(prefix = 'new') {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

test('createId returns unique RFC4122 v4 ids', () => {
  const first = createId();
  const second = createId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('refresh keeps metadata only and repairs a missing size', async () => {
  const blob = new Blob(['hello']);
  const db = fakeDb([
    { id: 'a', name: 'One', size: 5 },
    { id: 'b', name: 'Two', blob },
  ]);
  const repo = createRepository({ db });

  const listed = await repo.refresh();
  assert.equal(listed.length, 2);
  assert.equal(repo.get('b').size, 5, 'size is derived from the payload');
  for (const record of repo.all()) {
    assert.equal('blob' in record, false, 'payloads never enter the cache');
  }
});

test('create persists the payload and the metadata together', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, now: () => 1000, idFactory: ids('rec') });
  const blob = new Blob(['abc']);

  const record = await repo.create({
    blob,
    name: '  My note  ',
    mimeType: 'audio/webm',
    extension: 'webm',
    durationMs: 1234.7,
    tags: ['one'],
  });

  assert.equal(record.id, 'rec-1');
  assert.equal(record.name, 'My note');
  assert.equal(record.size, 3);
  assert.equal(record.durationMs, 1235);
  assert.equal(record.createdAt, 1000);
  assert.equal(record.updatedAt, 1000);
  assert.equal(db.blobs.get('rec-1'), blob);
  assert.deepEqual(db.calls[0].slice(0, 2), ['put', 'rec-1']);
  assert.equal(repo.isLoaded(), true);
});

test('update without a blob keeps the stored audio (rename/retag)', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, now: () => 1000, idFactory: () => 'rec-1' });
  const blob = new Blob(['audio']);
  await repo.create({ blob, name: 'Before' });

  const renamed = await repo.update('rec-1', { name: 'After', tags: ['x'] });
  assert.equal(renamed.name, 'After');
  assert.deepEqual(renamed.tags, ['x']);
  assert.equal(renamed.createdAt, 1000);
  assert.equal(db.blobs.get('rec-1'), blob, 'the payload was not replaced');
  assert.equal(repo.get('rec-1').name, 'After');
});

test('update can replace the audio payload for a trim', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, now: () => 1000, idFactory: () => 'rec-1' });
  await repo.create({ blob: new Blob(['long audio']), name: 'Take' });

  const trimmed = new Blob(['short']);
  // No `size` is passed: the replacement payload defines it.
  const record = await repo.update('rec-1', { blob: trimmed, trimmed: true });
  assert.equal(record.size, 5);
  assert.equal(record.trimmed, true);
  assert.equal(db.blobs.get('rec-1'), trimmed);
  assert.equal(repo.get('rec-1').size, 5);
});

test('update rejects an unknown id with a coded StorageError', async () => {
  const repo = createRepository({ db: fakeDb() });
  await assert.rejects(
    () => repo.update('missing', { name: 'x' }),
    (error) => error instanceof StorageError && error.code === 'not-found',
  );
});

test('remove and removeMany report what was actually deleted', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, now: () => 1, idFactory: ids('id') });
  await repo.create({ blob: new Blob(['a']), name: 'A' });
  await repo.create({ blob: new Blob(['b']), name: 'B' });
  await repo.create({ blob: new Blob(['c']), name: 'C' });

  assert.equal(await repo.remove('missing'), false);
  assert.equal(await repo.remove('id-1'), true);
  assert.equal(repo.get('id-1'), undefined);
  assert.equal(db.blobs.has('id-1'), false);

  assert.equal(await repo.removeMany(['id-2', 'id-2', 'nope']), 1);
  assert.equal(repo.all().length, 1);
  assert.equal(await repo.removeMany([]), 0);
});

test('restore repairs rows, avoids id collisions and writes payloads', async () => {
  const existing = new Blob(['old']);
  const db = fakeDb();
  const repo = createRepository({ db, now: () => 500, idFactory: ids('fresh') });
  await repo.create({ blob: existing, name: 'Existing' });
  const existingId = repo.all()[0].id;

  const payload = new Blob(['hello']);
  const inserted = await repo.restore([
    { record: { id: 'keep-me', name: 'Keep', size: 5 }, blob: payload },
    { record: { id: existingId, name: 'Duplicate' }, sizeHint: 1, blob: new Blob(['dup']) },
    { record: { name: 'No id', size: 2 } },
    { record: { name: 'No size' }, blob: new Blob(['abc']) },
    { record: null, blob: payload },
    { record: { name: 'Unusable' }, blob: null },
  ]);

  assert.equal(inserted.length, 4, 'unusable rows are skipped, not fatal');
  assert.equal(inserted[0].id, 'keep-me');
  assert.notEqual(inserted[1].id, existingId, 'a collision gets a fresh id');
  assert.equal(new Set(inserted.map((record) => record.id)).size, 4);
  assert.equal(inserted[2].size, 2);
  assert.equal(inserted[3].size, 3, 'size is derived from the payload');
  assert.equal(db.blobs.get('keep-me'), payload);
  assert.equal(repo.all().length, 5);
  assert.equal(db.calls.filter(([name]) => name === 'putMany').length, 1);
});

test('restore returns an empty list without writing anything', async () => {
  const db = fakeDb();
  const repo = createRepository({ db });
  assert.deepEqual(await repo.restore([]), []);
  assert.deepEqual(await repo.restore(null), []);
  assert.equal(db.calls.length, 0);
});

test('a failed restore leaves the cache and the database untouched', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, idFactory: ids('fresh') });
  await repo.refresh();
  db.failPutMany = true;

  await assert.rejects(
    () => repo.restore([{ record: { id: 'a', name: 'A', size: 1 } }]),
    (error) => error.code === 'quota-exceeded',
  );
  assert.equal(repo.all().length, 0);
  assert.equal(db.records.size, 0);
});

test('blobFor reads payloads on demand and ignores empty ids', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, idFactory: () => 'rec-1' });
  const blob = new Blob(['payload']);
  await repo.create({ blob, name: 'One' });

  assert.equal(await repo.blobFor('rec-1'), blob);
  assert.equal(await repo.blobFor('missing'), null);
  assert.equal(await repo.blobFor(''), null);
});

test('list filters, sorts and never exposes payloads', async () => {
  const db = fakeDb();
  let clock = 0;
  const repo = createRepository({ db, now: () => (clock += 1000), idFactory: ids('id') });
  await repo.create({ blob: new Blob(['a']), name: 'Meeting', tags: ['work'], durationMs: 2000 });
  await repo.create({ blob: new Blob(['bb']), name: 'Idea', tags: ['idea'], durationMs: 9000 });

  const newest = repo.list({ sort: 'newest' });
  assert.equal(newest.length, 2);
  assert.equal(newest[0].name, 'Idea', 'the later recording comes first');
  assert.equal(repo.list({ query: 'work' }).length, 1);
  assert.equal(repo.list({ query: 'IDEA' })[0].name, 'Idea');
  assert.deepEqual(
    repo.list({ sort: 'longest' }).map((record) => record.name),
    ['Idea', 'Meeting'],
  );
  for (const record of repo.list()) assert.equal('blob' in record, false);
});

test('stats, suggestName and all() describe the cache', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, now: () => 7, idFactory: ids('id') });
  await repo.create({ blob: new Blob(['abc']), name: 'Recording 1', durationMs: 1000 });
  await repo.create({ blob: new Blob(['de']), name: 'Recording 3', durationMs: 500 });

  const stats = repo.stats();
  assert.equal(stats.count, 2);
  assert.equal(stats.totalDurationMs, 1500);
  assert.equal(stats.totalBytes, 5);
  assert.equal(repo.suggestName(), 'Recording 4');
  assert.equal(repo.all().length, 2);
  assert.notEqual(repo.all(), repo.all(), 'all() returns a copy');
});

test('clear empties both the database and the cache', async () => {
  const db = fakeDb();
  const repo = createRepository({ db, idFactory: ids('id') });
  await repo.create({ blob: new Blob(['x']), name: 'One' });

  assert.equal(await repo.clear(), true);
  assert.deepEqual(repo.all(), []);
  assert.equal(repo.isLoaded(), true);
  assert.equal(db.records.size, 0);
  assert.equal(db.blobs.size, 0);
});
