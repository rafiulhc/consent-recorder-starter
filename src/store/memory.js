'use strict';
/**
 * In-memory store for tests and the demo. Implements the same interface as MongoStore;
 * test/store.contract.test.js runs one suite against both.
 */
class MemoryStore {
  constructor() {
    this.sessions = new Map();
    this.chunks = new Map();       // sessionId -> Map(seq -> events)
    this.certificates = new Map();
  }

  async init() {}
  async close() {}

  // ---- Sessions ----

  async createSession(session) {
    this.sessions.set(session.id, { ...session, status: 'open', bytes: 0, chunkCount: 0 });
    this.chunks.set(session.id, new Map());
  }

  async getSession(id) {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  /** Store one chunk of events. Idempotent per (session, seq). */
  async addChunk(id, seq, events, bytes, maxBytes) {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'not_found' };
    if (session.status !== 'open') return { ok: false, reason: 'closed' };
    const chunks = this.chunks.get(id);
    if (chunks.has(seq)) return { ok: true, duplicate: true };
    if (session.bytes + bytes > maxBytes) return { ok: false, reason: 'too_large' };
    chunks.set(seq, events);
    session.bytes += bytes;
    session.chunkCount += 1;
    return { ok: true };
  }

  async getEvents(id) {
    const chunks = this.chunks.get(id) || new Map();
    return [...chunks.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, events]) => events);
  }

  /** Atomically move an open session to "finalizing". Returns the session, or null. */
  async claimFinalize(id) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'open') return null;
    session.status = 'finalizing';
    return { ...session };
  }

  async releaseFinalize(id) {
    const session = this.sessions.get(id);
    if (session && session.status === 'finalizing') session.status = 'open';
  }

  async completeSession(id, certificateId) {
    const session = this.sessions.get(id);
    if (session) Object.assign(session, { status: 'finalized', certificateId });
    this.chunks.delete(id);
  }

  async deleteExpiredSessions(now) {
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        this.chunks.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  // ---- Certificates ----

  async insertCertificate(certificate) {
    this.certificates.set(certificate.id, structuredClone(certificate));
  }

  async getCertificate(id) {
    const certificate = this.certificates.get(id);
    return certificate ? structuredClone(certificate) : null;
  }

  async findCertificates({ phoneHash, emailHash, from, to } = {}, { limit = 50, skip = 0 } = {}) {
    const matches = [...this.certificates.values()]
      .filter((c) => !phoneHash || c.lead.phoneHash === phoneHash)
      .filter((c) => !emailHash || c.lead.emailHash === emailHash)
      .filter((c) => !from || c.createdAt >= from)
      .filter((c) => !to || c.createdAt <= to)
      .sort((a, b) => b.createdAt - a.createdAt);
    return { total: matches.length, items: matches.slice(skip, skip + limit).map((c) => structuredClone(c)) };
  }

  async deleteCertificate(id) {
    return this.certificates.delete(id);
  }

  async expiredCertificates(before, limit = 100) {
    return [...this.certificates.values()]
      .filter((c) => c.createdAt < before)
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }
}

module.exports = { MemoryStore };
