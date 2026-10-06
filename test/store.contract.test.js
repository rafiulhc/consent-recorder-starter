'use strict';
/**
 * One behaviour suite, run against every store implementation.
 * MongoStore runs when TEST_MONGODB_URI is set (CI starts a MongoDB service for it).
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MemoryStore } = require('../src/store/memory');
const { MongoStore } = require('../src/store/mongo');

const T0 = new Date('2026-10-06T17:00:00Z');
const later = (ms) => new Date(T0.getTime() + ms);

const implementations = [['MemoryStore', () => new MemoryStore()]];
if (process.env.TEST_MONGODB_URI) {
  implementations.push(['MongoStore', () => new MongoStore(process.env.TEST_MONGODB_URI, `consent_test_${crypto.randomBytes(4).toString('hex')}`)]);
}

for (const [name, create] of implementations) {
  describe(`${name} contract`, () => {
    let store;
    before(async () => { store = create(); await store.init(); });
    after(async () => {
      if (store.client) await store.client.db(store.dbName).dropDatabase();
      await store.close();
    });

    let id;
    beforeEach(async () => {
      id = crypto.randomBytes(16).toString('base64url');
      await store.createSession({ id, uploadTokenHash: 'h', origin: 'o', pageUrl: 'p', createdAt: T0, expiresAt: later(3_600_000) });
    });

    it('creates and reads sessions', async () => {
      const session = await store.getSession(id);
      assert.equal(session.id, id);
      assert.equal(session.status, 'open');
      assert.equal(session.bytes, 0);
    });

    it('adds chunks idempotently and returns events in seq order', async () => {
      assert.deepEqual(await store.addChunk(id, 1, [{ t: 2 }], 10, 100), { ok: true });
      assert.deepEqual(await store.addChunk(id, 0, [{ t: 1 }], 10, 100), { ok: true });
      assert.deepEqual(await store.addChunk(id, 0, [{ t: 1 }], 10, 100), { ok: true, duplicate: true });
      assert.deepEqual(await store.getEvents(id), [{ t: 1 }, { t: 2 }]);
      assert.equal((await store.getSession(id)).bytes, 20);
    });

    it('enforces the byte limit without keeping the rejected chunk', async () => {
      await store.addChunk(id, 0, [{ t: 1 }], 60, 100);
      assert.deepEqual(await store.addChunk(id, 1, [{ t: 2 }], 60, 100), { ok: false, reason: 'too_large' });
      assert.deepEqual(await store.getEvents(id), [{ t: 1 }]);
    });

    it('reports unknown sessions', async () => {
      assert.deepEqual(await store.addChunk('nope', 0, [{}], 1, 100), { ok: false, reason: 'not_found' });
    });

    it('lets only one caller claim finalize, and refuses chunks while finalizing', async () => {
      const claims = await Promise.all([store.claimFinalize(id), store.claimFinalize(id)]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.deepEqual(await store.addChunk(id, 0, [{}], 1, 100), { ok: false, reason: 'closed' });
      await store.releaseFinalize(id);
      assert.ok(await store.claimFinalize(id));
    });

    it('completing a session drops its chunks', async () => {
      await store.addChunk(id, 0, [{ t: 1 }], 10, 100);
      await store.claimFinalize(id);
      await store.completeSession(id, 'cert');
      assert.deepEqual(await store.getEvents(id), []);
      assert.equal((await store.getSession(id)).status, 'finalized');
    });

    it('stores, searches and deletes certificates', async () => {
      const make = (n, phoneHash, createdAt) => ({ id: `${id}-${n}`, createdAt, lead: { phoneHash, emailHash: null }, recording: { key: `k${n}` } });
      await store.insertCertificate(make(1, 'p1', later(1000)));
      await store.insertCertificate(make(2, 'p1', later(2000)));
      await store.insertCertificate(make(3, 'p2', later(3000)));

      const byPhone = await store.findCertificates({ phoneHash: 'p1' });
      assert.equal(byPhone.total, 2);
      assert.deepEqual(byPhone.items.map((c) => c.id), [`${id}-2`, `${id}-1`]); // newest first

      const ranged = await store.findCertificates({ phoneHash: 'p1', from: later(1500) });
      assert.deepEqual(ranged.items.map((c) => c.id), [`${id}-2`]);

      assert.equal((await store.getCertificate(`${id}-3`)).lead.phoneHash, 'p2');
      assert.equal(await store.deleteCertificate(`${id}-3`), true);
      assert.equal(await store.getCertificate(`${id}-3`), null);
      assert.equal(await store.deleteCertificate(`${id}-3`), false);

      const expired = await store.expiredCertificates(later(1500));
      assert.ok(expired.some((c) => c.id === `${id}-1`));
      assert.ok(!expired.some((c) => c.id === `${id}-2`));
    });

    it('deletes expired sessions and their chunks', async () => {
      await store.addChunk(id, 0, [{ t: 1 }], 10, 100);
      assert.ok(await store.deleteExpiredSessions(later(7_200_000)) >= 1);
      assert.equal(await store.getSession(id), null);
      assert.deepEqual(await store.getEvents(id), []);
    });
  });
}
