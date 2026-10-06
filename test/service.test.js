'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { ORIGIN, PII_SECRET, makeService, rrwebEvents } = require('./helpers');
const { piiHash, sha256 } = require('../src/security');

const PAGE = `${ORIGIN}/form`;

async function recorded(ctx, { events = rrwebEvents(), consent, lead } = {}) {
  const { sessionId, uploadToken } = await ctx.service.createSession({ origin: ORIGIN, pageUrl: PAGE, ip: '203.0.113.9', userAgent: 'Test' });
  await ctx.service.appendEvents(sessionId, uploadToken, { seq: 0, events }, 1000);
  const certificate = await ctx.service.finalize(sessionId, uploadToken, {
    consent: consent ?? { text: '  I agree\n to be   contacted. ', checked: true },
    lead: lead ?? { phone: '(555) 123-4567', email: 'Lead@Example.com ' },
  });
  return { sessionId, uploadToken, certificate };
}

const rejects = (promise, status) => assert.rejects(promise, (err) => err.status === status);

describe('creating a session', () => {
  it('returns unguessable 128-bit ids', async () => {
    const { service } = makeService();
    const a = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    const b = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    assert.match(a.sessionId, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.uploadToken, a.sessionId);
  });

  it('stores only a hash of the upload token', async () => {
    const ctx = makeService();
    const { sessionId, uploadToken } = await ctx.service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    const stored = await ctx.store.getSession(sessionId);
    assert.equal(stored.uploadTokenHash, sha256(uploadToken));
    assert.ok(!JSON.stringify(stored).includes(uploadToken));
  });

  it('rejects a page that is not on the recording origin', async () => {
    const { service } = makeService();
    await rejects(service.createSession({ origin: ORIGIN, pageUrl: 'https://evil.example/form' }), 400);
    await rejects(service.createSession({ origin: ORIGIN, pageUrl: 'not a url' }), 400);
  });

  it('can be told not to store IP addresses', async () => {
    const ctx = makeService({ STORE_IP: 'false' });
    const { certificate } = await recorded(ctx);
    assert.equal(certificate.ip, null);
  });
});

describe('uploading events', () => {
  it('needs the session’s upload token', async () => {
    const { service } = makeService();
    const { sessionId } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    await rejects(service.appendEvents(sessionId, 'wrong-token-wrong-token', { seq: 0, events: rrwebEvents() }, 10), 404);
    await rejects(service.appendEvents(sessionId, undefined, { seq: 0, events: rrwebEvents() }, 10), 404);
  });

  it('gives the same answer for unknown sessions and wrong tokens', async () => {
    const { service } = makeService();
    await rejects(service.appendEvents('A'.repeat(22), 'x', { seq: 0, events: rrwebEvents() }, 10), 404);
    await rejects(service.appendEvents('../../etc/passwd', 'x', { seq: 0, events: rrwebEvents() }, 10), 404);
  });

  it('treats a retried chunk as a duplicate, not new data', async () => {
    const { service, store } = makeService();
    const { sessionId, uploadToken } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    await service.appendEvents(sessionId, uploadToken, { seq: 0, events: rrwebEvents() }, 100);
    const retry = await service.appendEvents(sessionId, uploadToken, { seq: 0, events: rrwebEvents() }, 100);
    assert.equal(retry.duplicate, true);
    assert.equal((await store.getEvents(sessionId)).length, rrwebEvents().length);
  });

  it('keeps chunks in order, whatever order they arrive in', async () => {
    const { service, store } = makeService();
    const { sessionId, uploadToken } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    await service.appendEvents(sessionId, uploadToken, { seq: 1, events: [{ type: 3, timestamp: 2 }] }, 10);
    await service.appendEvents(sessionId, uploadToken, { seq: 0, events: [{ type: 3, timestamp: 1 }] }, 10);
    assert.deepEqual((await store.getEvents(sessionId)).map((e) => e.timestamp), [1, 2]);
  });

  it('enforces the per-session size limit', async () => {
    const { service } = makeService({ MAX_SESSION_BYTES: '2048' });
    const { sessionId, uploadToken } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    await service.appendEvents(sessionId, uploadToken, { seq: 0, events: rrwebEvents() }, 1500);
    await rejects(service.appendEvents(sessionId, uploadToken, { seq: 1, events: rrwebEvents() }, 1500), 413);
  });

  it('rejects events after the session expires', async () => {
    const { service, clock } = makeService({ MAX_SESSION_MINUTES: '30' });
    const { sessionId, uploadToken } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    clock.advance(31 * 60_000);
    await rejects(service.appendEvents(sessionId, uploadToken, { seq: 0, events: rrwebEvents() }, 10), 410);
  });

  for (const [label, chunk] of [
    ['a negative seq', { seq: -1, events: rrwebEvents() }],
    ['a fractional seq', { seq: 1.5, events: rrwebEvents() }],
    ['no events', { seq: 0, events: [] }],
    ['events that are not rrweb events', { seq: 0, events: [{ hello: 'world' }] }],
    ['events that are not an array', { seq: 0, events: 'lots' }],
  ]) {
    it(`rejects ${label}`, async () => {
      const { service } = makeService();
      const { sessionId, uploadToken } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
      await rejects(service.appendEvents(sessionId, uploadToken, chunk, 10), 400);
    });
  }
});

describe('finalizing into a certificate', () => {
  it('records the consent text, checkbox and page', async () => {
    const { certificate } = await recorded(makeService());
    assert.equal(certificate.consent.text, 'I agree to be contacted.');
    assert.equal(certificate.consent.textSha256, sha256('I agree to be contacted.'));
    assert.equal(certificate.consent.checkboxChecked, true);
    assert.equal(certificate.pageUrl, PAGE);
  });

  it('never stores the phone number or email in plain text', async () => {
    const ctx = makeService();
    const { certificate } = await recorded(ctx);
    assert.equal(certificate.lead.phoneHash, piiHash(PII_SECRET, '15551234567'));
    assert.equal(certificate.lead.emailHash, piiHash(PII_SECRET, 'lead@example.com'));
    assert.equal(certificate.lead.phoneLast4, '4567');
    const stored = JSON.stringify(await ctx.store.getCertificate(certificate.id));
    assert.ok(!stored.includes('5551234567') && !stored.includes('lead@example.com'));
  });

  it('stores no phone or email hashes without PII_HASH_SECRET', async () => {
    const { certificate } = await recorded(makeService({ PII_HASH_SECRET: '' }));
    assert.equal(certificate.lead.phoneHash, null);
    assert.equal(certificate.lead.emailHash, null);
  });

  it('stores the recording compressed, with a SHA-256 fingerprint', async () => {
    const ctx = makeService();
    const { certificate } = await recorded(ctx);
    const body = await ctx.blobs.get(certificate.recording.key);
    assert.equal(sha256(body), certificate.recording.sha256);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(body)), rrwebEvents());
    assert.equal(certificate.recording.eventCount, 5);
    assert.equal(certificate.recording.durationMs, 3000);
  });

  it('can only finalize once', async () => {
    const ctx = makeService();
    const { sessionId, uploadToken } = await recorded(ctx);
    await rejects(ctx.service.finalize(sessionId, uploadToken, {}), 409);
  });

  it('refuses a recording without a page snapshot, and lets the session continue', async () => {
    const { service } = makeService();
    const { sessionId, uploadToken } = await service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    await service.appendEvents(sessionId, uploadToken, { seq: 0, events: [{ type: 3, timestamp: 1 }] }, 10);
    await rejects(service.finalize(sessionId, uploadToken, {}), 422);
    await service.appendEvents(sessionId, uploadToken, { seq: 1, events: rrwebEvents() }, 10);
    assert.ok((await service.finalize(sessionId, uploadToken, {})).id);
  });

  it('leaves the session open if storing the recording fails', async () => {
    const ctx = makeService();
    const { sessionId, uploadToken } = await ctx.service.createSession({ origin: ORIGIN, pageUrl: PAGE });
    await ctx.service.appendEvents(sessionId, uploadToken, { seq: 0, events: rrwebEvents() }, 10);
    const put = ctx.blobs.put;
    ctx.blobs.put = async () => { throw new Error('S3 unavailable'); };
    await assert.rejects(ctx.service.finalize(sessionId, uploadToken, {}), /S3 unavailable/);
    ctx.blobs.put = put;
    assert.ok((await ctx.service.finalize(sessionId, uploadToken, {})).id);
  });

  it('caps very long consent text', async () => {
    const { certificate } = await recorded(makeService(), { consent: { text: 'a'.repeat(20_000) } });
    assert.equal(certificate.consent.text.length, 10_000);
  });
});

describe('reading recordings', () => {
  it('detects a recording that was changed after the certificate was issued', async () => {
    const ctx = makeService();
    const { certificate } = await recorded(ctx);
    ctx.blobs.objects.set(certificate.recording.key, zlib.gzipSync('[]'));
    await rejects(ctx.service.getRecording(certificate), 500);
  });
});

describe('admin search', () => {
  it('finds certificates by full phone number or email, in any format', async () => {
    const ctx = makeService();
    const { certificate } = await recorded(ctx);
    await recorded(ctx, { lead: { phone: '555-999-0000' } });
    for (const query of [{ phone: '+1 555 123 4567' }, { phone: '5551234567' }, { email: 'LEAD@example.com' }]) {
      const result = await ctx.service.searchCertificates(query);
      assert.deepEqual(result.items.map((c) => c.id), [certificate.id], JSON.stringify(query));
    }
  });

  it('refuses partial phone numbers, so nobody can search by last 4 digits', async () => {
    const { service } = makeService();
    await rejects(service.searchCertificates({ phone: '4567' }), 400);
  });

  it('filters by date and pages results', async () => {
    const ctx = makeService();
    await recorded(ctx);
    ctx.clock.advance(86_400_000);
    await recorded(ctx);
    await recorded(ctx);
    assert.equal((await ctx.service.searchCertificates({ from: '2026-10-07T00:00:00Z' })).total, 2);
    const page = await ctx.service.searchCertificates({ limit: 2, page: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 1);
  });

  it('rejects invalid dates', async () => {
    const { service } = makeService();
    await rejects(service.searchCertificates({ from: 'yesterday-ish' }), 400);
  });
});

describe('deletion and retention', () => {
  it('deletes a certificate together with its recording', async () => {
    const ctx = makeService();
    const { certificate } = await recorded(ctx);
    assert.equal(await ctx.service.deleteCertificate(certificate.id), true);
    assert.equal(await ctx.store.getCertificate(certificate.id), null);
    assert.equal(await ctx.blobs.get(certificate.recording.key), null);
  });

  it('removes abandoned sessions and certificates past the retention period', async () => {
    const ctx = makeService({ RETENTION_DAYS: '30' });
    const old = await recorded(ctx);
    await ctx.service.createSession({ origin: ORIGIN, pageUrl: PAGE }); // abandoned
    ctx.clock.advance(31 * 86_400_000);
    const recent = await recorded(ctx);

    const removed = await ctx.service.runRetention();
    assert.deepEqual(removed, { sessions: 2, certificates: 1 });
    assert.equal(await ctx.store.getCertificate(old.certificate.id), null);
    assert.equal(await ctx.blobs.get(old.certificate.recording.key), null);
    assert.ok(await ctx.store.getCertificate(recent.certificate.id));
  });
});
