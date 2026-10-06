'use strict';
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { randomToken, isToken, sha256, secretMatches, normalizePhone, normalizeEmail, piiHash } = require('./security');

const gzip = promisify(zlib.gzip);

const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
const MAX_EVENTS_PER_CHUNK = 10_000;
const MAX_CONSENT_TEXT = 10_000;
const MAX_SEQ = 100_000;

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Recording lifecycle: create a session, append rrweb events, finalize into a certificate.
 * Pure business logic: no Express, and storage/clock are injected.
 */
class ConsentService {
  constructor({ config, store, blobs, clock = () => new Date() }) {
    this.config = config;
    this.store = store;
    this.blobs = blobs;
    this.clock = clock;
  }

  // ---- Recording ----

  async createSession({ origin, pageUrl, ip, userAgent }) {
    let page;
    try {
      page = new URL(pageUrl);
    } catch {
      throw new AppError(400, 'pageUrl must be a valid URL');
    }
    if (page.origin !== origin) throw new AppError(400, 'pageUrl must belong to the recording origin');

    const now = this.clock();
    const id = randomToken();
    const uploadToken = randomToken();
    await this.store.createSession({
      id,
      uploadTokenHash: sha256(uploadToken),
      origin,
      pageUrl: page.href.slice(0, 2048),
      ip: this.config.storeIp ? ip : null,
      userAgent: String(userAgent || '').slice(0, 512),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.maxSessionMinutes * 60_000),
    });
    return { sessionId: id, uploadToken };
  }

  async authorizedSession(sessionId, uploadToken) {
    if (!isToken(sessionId)) throw new AppError(404, 'Session not found');
    const session = await this.store.getSession(sessionId);
    if (!session || !secretMatches(sha256(String(uploadToken || '')), session.uploadTokenHash)) {
      throw new AppError(404, 'Session not found'); // same answer for both: don't reveal which sessions exist
    }
    if (session.expiresAt <= this.clock()) throw new AppError(410, 'Session expired');
    return session;
  }

  async appendEvents(sessionId, uploadToken, { seq, events }, bytes) {
    await this.authorizedSession(sessionId, uploadToken);
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) throw new AppError(400, 'seq must be an integer');
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_CHUNK) {
      throw new AppError(400, `events must be a non-empty array of at most ${MAX_EVENTS_PER_CHUNK}`);
    }
    if (!events.every((e) => e && typeof e === 'object' && Number.isFinite(e.timestamp) && Number.isInteger(e.type))) {
      throw new AppError(400, 'events must be rrweb events');
    }

    const result = await this.store.addChunk(sessionId, seq, events, bytes, this.config.maxSessionBytes);
    if (!result.ok) {
      const status = { too_large: 413, closed: 409, not_found: 404 }[result.reason] || 400;
      throw new AppError(status, `Cannot add events: ${result.reason}`);
    }
    return { accepted: events.length, duplicate: Boolean(result.duplicate) };
  }

  async finalize(sessionId, uploadToken, { consent = {}, lead = {} } = {}) {
    await this.authorizedSession(sessionId, uploadToken);
    const session = await this.store.claimFinalize(sessionId);
    if (!session) throw new AppError(409, 'Session is already finalized');

    try {
      const events = await this.store.getEvents(sessionId);
      if (!events.some((e) => e.type === FULL_SNAPSHOT)) {
        throw new AppError(422, 'Recording has no page snapshot');
      }

      const now = this.clock();
      const id = randomToken();
      const body = await gzip(JSON.stringify(events));
      // reduce, not Math.max(...): spreading 100k+ events would overflow the call stack
      const first = events.reduce((min, e) => Math.min(min, e.timestamp), Infinity);
      const last = events.reduce((max, e) => Math.max(max, e.timestamp), -Infinity);
      const key = `recordings/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.json.gz`;
      await this.blobs.put(key, body);

      const consentText = String(consent.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONSENT_TEXT);
      const phone = normalizePhone(lead.phone);
      const email = normalizeEmail(lead.email);

      const certificate = {
        id,
        sessionId,
        createdAt: now,
        sessionStartedAt: session.createdAt,
        pageUrl: session.pageUrl,
        origin: session.origin,
        ip: session.ip,
        userAgent: session.userAgent,
        consent: {
          text: consentText || null,
          textSha256: consentText ? sha256(consentText) : null,
          checkboxChecked: typeof consent.checked === 'boolean' ? consent.checked : null,
        },
        lead: {
          phoneHash: piiHash(this.config.piiHashSecret, phone),
          phoneLast4: phone ? phone.slice(-4) : null,
          emailHash: piiHash(this.config.piiHashSecret, email),
        },
        recording: {
          key,
          sha256: sha256(body),
          bytes: body.length,
          eventCount: events.length,
          durationMs: last - first,
        },
      };
      await this.store.insertCertificate(certificate);
      await this.store.completeSession(sessionId, id);
      return certificate;
    } catch (err) {
      await this.store.releaseFinalize(sessionId);
      throw err;
    }
  }

  // ---- Certificates ----

  certificateUrl(id) {
    return `${this.config.publicUrl}/c/${id}`;
  }

  async getCertificate(id) {
    if (!isToken(id)) return null;
    return this.store.getCertificate(id);
  }

  /** The gzipped recording, after checking it still matches the hash in the certificate. */
  async getRecording(certificate) {
    const body = await this.blobs.get(certificate.recording.key);
    if (!body) throw new AppError(404, 'Recording not found');
    if (sha256(body) !== certificate.recording.sha256) {
      throw new AppError(500, 'Recording failed its integrity check');
    }
    return body;
  }

  async searchCertificates({ phone, email, from, to, limit = 50, page = 1 }) {
    const filter = {};
    if (phone) {
      const normalized = normalizePhone(phone);
      if (!normalized) throw new AppError(400, 'phone must be a full phone number');
      if (!this.config.piiHashSecret) throw new AppError(503, 'Phone search needs PII_HASH_SECRET');
      filter.phoneHash = piiHash(this.config.piiHashSecret, normalized);
    }
    if (email) {
      const normalized = normalizeEmail(email);
      if (!normalized) throw new AppError(400, 'email is not valid');
      if (!this.config.piiHashSecret) throw new AppError(503, 'Email search needs PII_HASH_SECRET');
      filter.emailHash = piiHash(this.config.piiHashSecret, normalized);
    }
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new AppError(400, `${name} must be a date`);
        filter[name] = date;
      }
    }
    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * size;
    return this.store.findCertificates(filter, { limit: size, skip });
  }

  /** Delete a certificate and its recording, e.g. for a data-deletion request. */
  async deleteCertificate(id) {
    const certificate = await this.getCertificate(id);
    if (!certificate) return false;
    await this.blobs.delete(certificate.recording.key);
    return this.store.deleteCertificate(id);
  }

  /** Remove expired sessions and certificates older than RETENTION_DAYS. */
  async runRetention() {
    const now = this.clock();
    const sessions = await this.store.deleteExpiredSessions(now);
    const cutoff = new Date(now.getTime() - this.config.retentionDays * 86_400_000);
    let certificates = 0;
    for (;;) {
      const batch = await this.store.expiredCertificates(cutoff, 100);
      if (!batch.length) break;
      for (const certificate of batch) {
        await this.blobs.delete(certificate.recording.key);
        await this.store.deleteCertificate(certificate.id);
        certificates += 1;
      }
    }
    return { sessions, certificates };
  }
}

module.exports = { ConsentService, AppError };
