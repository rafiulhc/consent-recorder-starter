'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ORIGIN, ADMIN_TOKEN, startServer, post, recordAndFinalize, rrwebEvents } = require('./helpers');

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

describe('HTTP API', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.close());

  describe('recording is limited to allowed websites', () => {
    it('rejects requests from other origins, server-side', async () => {
      const res = await post(srv.base, '/api/sessions', { pageUrl: 'https://evil.example/' }, { origin: 'https://evil.example' });
      assert.equal(res.status, 403);
    });

    it('rejects requests with no origin (scripts, curl)', async () => {
      const res = await post(srv.base, '/api/sessions', { pageUrl: `${ORIGIN}/` }, { origin: null });
      assert.equal(res.status, 403);
    });

    it('answers the allowed origin’s CORS preflight, without credentials', async () => {
      const res = await fetch(`${srv.base}/api/sessions`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
    });

    it('is switched off entirely until RECORDER_ALLOWED_ORIGINS is set', async () => {
      const off = await startServer({ RECORDER_ALLOWED_ORIGINS: '' });
      try {
        assert.equal((await post(off.base, '/api/sessions', { pageUrl: `${ORIGIN}/` })).status, 503);
      } finally {
        await off.close();
      }
    });
  });

  describe('the full recording flow', () => {
    it('records, finalizes and returns a certificate link', async () => {
      const { response, body } = await recordAndFinalize(srv.base);
      assert.equal(response.status, 201);
      assert.match(body.certificateUrl, /^https:\/\/consent\.example\.com\/c\/[A-Za-z0-9_-]{22}$/);
    });

    it('needs the upload token for events and finalize', async () => {
      const session = await (await post(srv.base, '/api/sessions', { pageUrl: `${ORIGIN}/form` })).json();
      const events = await post(srv.base, `/api/sessions/${session.sessionId}/events`, { seq: 0, events: rrwebEvents() });
      const finalize = await post(srv.base, `/api/sessions/${session.sessionId}/finalize`, {});
      assert.equal(events.status, 404);
      assert.equal(finalize.status, 404);
    });

    it('rejects oversized and malformed uploads', async () => {
      const small = await startServer({ MAX_CHUNK_BYTES: '2048' });
      try {
        const session = await (await post(small.base, '/api/sessions', { pageUrl: `${ORIGIN}/form` })).json();
        const big = { seq: 0, events: [{ type: 3, timestamp: 1, data: 'x'.repeat(5000) }] };
        assert.equal((await post(small.base, `/api/sessions/${session.sessionId}/events`, big, { token: session.uploadToken })).status, 413);
        assert.equal((await post(small.base, `/api/sessions/${session.sessionId}/events`, '{not json', { token: session.uploadToken })).status, 400);
      } finally {
        await small.close();
      }
    });
  });

  describe('certificate pages', () => {
    it('shows the certificate and escapes everything from the recorded page', async () => {
      const { body } = await recordAndFinalize(srv.base, { consent: { text: '<script>alert(1)</script> I agree', checked: true } });
      const res = await fetch(`${srv.base}/c/${body.certificateId}`);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; I agree'));
      assert.ok(!html.includes('<script>alert(1)'));
      assert.ok(html.includes('•••-•••-4567'));
    });

    it('is not indexed, cached or framed, and has a strict script policy', async () => {
      const { body } = await recordAndFinalize(srv.base);
      const res = await fetch(`${srv.base}/c/${body.certificateId}`);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
      assert.match(csp, /frame-ancestors 'none'/);
    });

    it('serves the recording, which only contains the recorded events', async () => {
      const { body } = await recordAndFinalize(srv.base);
      const res = await fetch(`${srv.base}/c/${body.certificateId}/recording`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), rrwebEvents());
    });

    it('JSON view leaves out hashes, IP address and user agent', async () => {
      const { body } = await recordAndFinalize(srv.base, { lead: { phone: '5551234567', email: 'a@b.co' } });
      const json = await (await fetch(`${srv.base}/c/${body.certificateId}/json`)).json();
      assert.deepEqual(Object.keys(json.lead), ['phoneLast4']);
      assert.equal(json.ip, undefined);
      assert.equal(json.userAgent, undefined);
      assert.equal(json.recording.key, undefined);
    });

    it('unknown or malformed ids are simply not found', async () => {
      for (const id of ['A'.repeat(22), '507f1f77bcf86cd799439011', '..%2F..%2Fetc']) {
        assert.equal((await fetch(`${srv.base}/c/${id}`)).status, 404, id);
      }
    });
  });

  describe('admin API', () => {
    it('needs the admin token', async () => {
      assert.equal((await fetch(`${srv.base}/api/admin/certificates`)).status, 401);
      assert.equal((await fetch(`${srv.base}/api/admin/certificates`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    });

    it('is switched off entirely until ADMIN_TOKEN is set', async () => {
      const off = await startServer({ ADMIN_TOKEN: '' });
      try {
        const res = await fetch(`${off.base}/api/admin/certificates`, { headers: { Authorization: 'Bearer ' } });
        assert.equal(res.status, 503);
      } finally {
        await off.close();
      }
    });

    it('searches by phone and shows full details', async () => {
      const { body } = await recordAndFinalize(srv.base, { lead: { phone: '(555) 777-1212' } });
      const search = await (await fetch(`${srv.base}/api/admin/certificates?phone=5557771212`, { headers: admin })).json();
      assert.deepEqual(search.items.map((c) => c.id), [body.certificateId]);
      const detail = await (await fetch(`${srv.base}/api/admin/certificates/${body.certificateId}`, { headers: admin })).json();
      assert.ok(detail.lead.phoneHash && detail.userAgent !== undefined);
    });

    it('deletes certificates', async () => {
      const { body } = await recordAndFinalize(srv.base);
      const url = `${srv.base}/api/admin/certificates/${body.certificateId}`;
      assert.equal((await fetch(url, { method: 'DELETE', headers: admin })).status, 204);
      assert.equal((await fetch(`${srv.base}/c/${body.certificateId}`)).status, 404);
      assert.equal((await fetch(url, { method: 'DELETE', headers: admin })).status, 404);
    });

    it('turns bad input into a 400, not a crash', async () => {
      const res = await fetch(`${srv.base}/api/admin/certificates?phone=12`, { headers: admin });
      assert.equal(res.status, 400);
    });
  });

  describe('scripts for recorded websites', () => {
    it('serves the recorder and rrweb so other origins can load them', async () => {
      for (const path of ['/recorder.js', '/vendor/rrweb.min.js']) {
        const res = await fetch(srv.base + path);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get('content-type'), /javascript/);
        assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
      }
    });

    it('serves only known vendor files', async () => {
      assert.equal((await fetch(`${srv.base}/vendor/..%2Fpackage.json`)).status, 404);
      assert.equal((await fetch(`${srv.base}/vendor/express.js`)).status, 404);
    });

    it('never exposes stack traces or internals', async () => {
      const res = await fetch(`${srv.base}/nope`);
      assert.deepEqual(await res.json(), { error: 'Not found' });
      assert.equal(res.headers.get('x-powered-by'), null);
    });
  });
});
