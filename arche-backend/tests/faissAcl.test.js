// Unit test of the vector layer: authorization is enforced inside search().
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.DATA_DIR = `/tmp/faiss-unit-${process.pid}`;

import test from 'node:test';
import assert from 'node:assert/strict';

const { FaissVectorStore } = await import('../src/services/vector/faissStore.js');
const { canAccess } = await import('../src/security/acl.js');

const unit = (i, dim = 8) => Array.from({ length: dim }, (_, k) => (k === i ? 1 : 0));
const U = (username, role) => ({ username, role });

test('canAccess policy matrix', () => {
  const hr = { department: 'HR', allowedRoles: [], allowedUsers: [] };
  assert.equal(canAccess(U('a', 'ADMIN'), hr), true);
  assert.equal(canAccess(U('h', 'HR'), hr), true);
  assert.equal(canAccess(U('e', 'EMPLOYEE'), hr), false);
  const row = { department: 'HR', allowedRoles: ['HR'], allowedUsers: ['eric'] };
  assert.equal(canAccess(U('eric', 'EMPLOYEE'), row), true, 'row owner');
  assert.equal(canAccess(U('bob', 'EMPLOYEE'), row), false);
  const priv = { department: 'GENERAL', allowedRoles: [], allowedUsers: ['eric'] };
  assert.equal(canAccess(U('bob', 'HR'), priv), false, 'private doc hidden from other staff');
  assert.equal(canAccess(U('eric', 'EMPLOYEE'), priv), true);
  assert.equal(canAccess(U('x', 'HR'), undefined), false, 'fail closed on missing ACL');
  assert.equal(canAccess(null, hr), false);
});

test('search never returns unauthorized vectors, even when they are the nearest', () => {
  const s = new FaissVectorStore().init();
  const dim = 8;
  const q = unit(0); // query is identical to the SECRET vectors
  return s.add([
    { chunkId: 'secret-hr-1', documentId: 'd1', acl: { department: 'HR', allowedRoles: [], allowedUsers: [] }, vector: unit(0) },
    { chunkId: 'secret-hr-2', documentId: 'd2', acl: { department: 'HR', allowedRoles: ['HR'], allowedUsers: [] }, vector: unit(0) },
    { chunkId: 'own-row', documentId: 'd2', acl: { department: 'HR', allowedRoles: ['HR'], allowedUsers: ['eric'] }, vector: unit(1) },
    ...Array.from({ length: 40 }, (_, i) => ({ chunkId: `pub-${i}`, documentId: 'd3', acl: { department: 'GENERAL', allowedRoles: [], allowedUsers: [] }, vector: unit(2 + (i % 5)) })),
  ], { dim, model: 'm' }).then(() => {
    const emp = s.search(U('eric', 'EMPLOYEE'), q, 5);
    const ids = emp.hits.map((h) => h.chunkId);
    assert.ok(!ids.includes('secret-hr-1') && !ids.includes('secret-hr-2'));
    assert.ok(ids.includes('own-row'), 'owner can retrieve their own HR-table row');

    const other = s.search(U('bob', 'EMPLOYEE'), q, 5).hits.map((h) => h.chunkId);
    assert.ok(!other.includes('own-row'));

    const hr = s.search(U('h', 'HR'), q, 5).hits.map((h) => h.chunkId);
    assert.ok(hr.includes('secret-hr-1') && !hr.includes('secret-fin-1'));

    const admin = s.search(U('admin', 'ADMIN'), q, 5).hits.map((h) => h.chunkId);
    assert.ok(admin.includes('secret-hr-1') && admin.includes('secret-fin-1'));

    assert.throws(() => s.search(null, q, 5), /principal/);
  });
});

test('over-fetch: authorized hits are found even if hundreds of unauthorized vectors outrank them', async () => {
  const s = new FaissVectorStore().init();
  await s.reset();
  const dim = 4;
  const items = [];
  for (let i = 0; i < 300; i++) items.push({ chunkId: `hr-${i}`, documentId: 'x', acl: { department: 'GENERAL', allowedRoles: ['HR'], allowedUsers: [] }, vector: [1, 0, 0, 0] });
  items.push({ chunkId: 'open', documentId: 'y', acl: { department: 'GENERAL', allowedRoles: [], allowedUsers: [] }, vector: [0.1, 1, 0, 0] });
  await s.add(items, { dim, model: 'm' });
  const hits = s.search(U('eric', 'EMPLOYEE'), [1, 0, 0, 0], 3).hits;
  assert.deepEqual(hits.map((h) => h.chunkId), ['open']);
});

test('removeDocument deletes vectors and persists', async () => {
  const s = new FaissVectorStore().init();
  await s.reset();
  await s.add([
    { chunkId: 'a', documentId: 'A', acl: { department: 'GENERAL', allowedRoles: [], allowedUsers: [] }, vector: [1, 0] },
    { chunkId: 'b', documentId: 'B', acl: { department: 'GENERAL', allowedRoles: [], allowedUsers: [] }, vector: [0, 1] },
    { chunkId: 'c', documentId: 'A', acl: { department: 'GENERAL', allowedRoles: [], allowedUsers: [] }, vector: [1, 1] },
  ], { dim: 2, model: 'm' });
  assert.equal(await s.removeDocument('A'), 2);
  const reloaded = new FaissVectorStore().init();
  assert.equal(reloaded.size(), 1);
  assert.deepEqual(reloaded.search(U('e', 'EMPLOYEE'), [1, 0], 5).hits.map((h) => h.chunkId), ['b']);
});
