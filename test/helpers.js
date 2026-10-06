'use strict';
const { loadConfig } = require('../src/config');
const { MemoryStore } = require('../src/store/memory');
const { MemoryBlobStore } = require('../src/blobs/memory');
const { ConsentService } = require('../src/service');
const { createApp } = require('../src/app');

const ORIGIN = 'https://forms.example.com';
const ADMIN_TOKEN = 'admin-token-for-tests';
const PII_SECRET = 'x'.repeat(32);

function makeConfig(env = {}) {
  return loadConfig({
    STORAGE: 'memory',
    BLOB_STORAGE: 'local',
    PUBLIC_URL: 'https://consent.example.com',
    RECORDER_ALLOWED_ORIGINS: ORIGIN,
    ADMIN_TOKEN,
    PII_HASH_SECRET: PII_SECRET,
    ...env,
  });
}

/** A controllable clock: set clock.now to move time. */
function makeClock(start = '2026-10-06T17:00:00Z') {
  const clock = () => new Date(clock.now);
  clock.now = new Date(start).getTime();
  clock.advance = (ms) => { clock.now += ms; };
  return clock;
}

function makeService(env, { clock = makeClock(), store = new MemoryStore(), blobs = new MemoryBlobStore() } = {}) {
  const config = makeConfig(env);
  return { service: new ConsentService({ config, store, blobs, clock }), config, store, blobs, clock };
}

/** Minimal rrweb-shaped events: Meta, FullSnapshot, then some incremental events. */
function rrwebEvents(start = 1_760_000_000_000, count = 3) {
  return [
    { type: 4, timestamp: start, data: { href: `${ORIGIN}/form`, width: 1280, height: 800 } },
    { type: 2, timestamp: start + 10, data: { node: { type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } } },
    ...Array.from({ length: count }, (_, i) => ({ type: 3, timestamp: start + 1000 * (i + 1), data: { source: 1, positions: [] } })),
  ];
}

/** Start the full HTTP app on a random port. */
async function startServer(env, options = {}) {
  const ctx = makeService(env, options);
  const app = createApp({ config: ctx.config, service: ctx.service, logger: { info() {}, error() {}, warn() {} } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, base, close: () => new Promise((r) => server.close(r)) };
}

/** POST JSON as the recorder would, from the allowed origin by default. */
function post(base, path, body, { origin = ORIGIN, token, headers = {} } = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin && { Origin: origin }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Record and finalize a session over HTTP. Returns the finalize response body. */
async function recordAndFinalize(base, { consent, lead, events = rrwebEvents() } = {}) {
  const session = await (await post(base, '/api/sessions', { pageUrl: `${ORIGIN}/form` })).json();
  await post(base, `/api/sessions/${session.sessionId}/events`, { seq: 0, events }, { token: session.uploadToken });
  const response = await post(base, `/api/sessions/${session.sessionId}/finalize`,
    { consent: consent || { text: 'I agree to be contacted.', checked: true }, lead: lead || { phone: '(555) 123-4567' } },
    { token: session.uploadToken });
  return { session, response, body: await response.json() };
}

module.exports = { ORIGIN, ADMIN_TOKEN, PII_SECRET, makeConfig, makeClock, makeService, rrwebEvents, startServer, post, recordAndFinalize };
