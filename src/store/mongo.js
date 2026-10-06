'use strict';
const { MongoClient } = require('mongodb');

/**
 * MongoDB store. Same interface as MemoryStore; every state change that could race
 * (adding chunks, finalizing) is a single atomic update.
 */
class MongoStore {
  constructor(uri, dbName, { client } = {}) {
    this.client = client || new MongoClient(uri);
    this.dbName = dbName;
  }

  async init() {
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.sessions = db.collection('sessions');
    this.chunks = db.collection('session_chunks');
    this.certificates = db.collection('certificates');

    await Promise.all([
      // Unfinished sessions and their chunks are removed by MongoDB itself once expired
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.chunks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.chunks.createIndex({ sessionId: 1, seq: 1 }, { unique: true }),
      this.certificates.createIndex({ createdAt: -1 }),
      this.certificates.createIndex({ 'lead.phoneHash': 1, createdAt: -1 }, { sparse: true }),
      this.certificates.createIndex({ 'lead.emailHash': 1, createdAt: -1 }, { sparse: true }),
    ]);
  }

  async close() {
    await this.client.close();
  }

  // ---- Sessions ----

  async createSession(session) {
    const { id, ...rest } = session;
    await this.sessions.insertOne({ _id: id, ...rest, status: 'open', bytes: 0, chunkCount: 0 });
  }

  async getSession(id) {
    const doc = await this.sessions.findOne({ _id: id });
    return doc ? fromDoc(doc) : null;
  }

  async addChunk(id, seq, events, bytes, maxBytes) {
    const session = await this.sessions.findOne({ _id: id }, { projection: { status: 1, expiresAt: 1 } });
    if (!session) return { ok: false, reason: 'not_found' };
    if (session.status !== 'open') return { ok: false, reason: 'closed' };

    try {
      await this.chunks.insertOne({ sessionId: id, seq, events, bytes, expiresAt: session.expiresAt });
    } catch (err) {
      if (err.code === 11000) return { ok: true, duplicate: true }; // retried upload
      throw err;
    }

    // Reserve the bytes atomically; undo the chunk if the session is over its limit or closed
    const updated = await this.sessions.findOneAndUpdate(
      { _id: id, status: 'open', bytes: { $lte: maxBytes - bytes } },
      { $inc: { bytes, chunkCount: 1 } },
    );
    if (!updated) {
      await this.chunks.deleteOne({ sessionId: id, seq });
      const now = await this.sessions.findOne({ _id: id }, { projection: { status: 1 } });
      return { ok: false, reason: now && now.status === 'open' ? 'too_large' : 'closed' };
    }
    return { ok: true };
  }

  async getEvents(id) {
    const chunks = await this.chunks.find({ sessionId: id }).sort({ seq: 1 }).toArray();
    return chunks.flatMap((chunk) => chunk.events);
  }

  async claimFinalize(id) {
    const doc = await this.sessions.findOneAndUpdate(
      { _id: id, status: 'open' },
      { $set: { status: 'finalizing' } },
      { returnDocument: 'after' },
    );
    return doc ? fromDoc(doc) : null;
  }

  async releaseFinalize(id) {
    await this.sessions.updateOne({ _id: id, status: 'finalizing' }, { $set: { status: 'open' } });
  }

  async completeSession(id, certificateId) {
    await this.sessions.updateOne({ _id: id }, { $set: { status: 'finalized', certificateId } });
    await this.chunks.deleteMany({ sessionId: id });
  }

  async deleteExpiredSessions(now) {
    const expired = await this.sessions.find({ expiresAt: { $lte: now } }, { projection: { _id: 1 } }).toArray();
    const ids = expired.map((s) => s._id);
    if (!ids.length) return 0;
    await this.chunks.deleteMany({ sessionId: { $in: ids } });
    const result = await this.sessions.deleteMany({ _id: { $in: ids } });
    return result.deletedCount;
  }

  // ---- Certificates ----

  async insertCertificate(certificate) {
    const { id, ...rest } = certificate;
    await this.certificates.insertOne({ _id: id, ...rest });
  }

  async getCertificate(id) {
    const doc = await this.certificates.findOne({ _id: id });
    return doc ? fromDoc(doc) : null;
  }

  async findCertificates({ phoneHash, emailHash, from, to } = {}, { limit = 50, skip = 0 } = {}) {
    const filter = {};
    if (phoneHash) filter['lead.phoneHash'] = phoneHash;
    if (emailHash) filter['lead.emailHash'] = emailHash;
    if (from || to) filter.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [total, docs] = await Promise.all([
      this.certificates.countDocuments(filter),
      this.certificates.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    ]);
    return { total, items: docs.map(fromDoc) };
  }

  async deleteCertificate(id) {
    const result = await this.certificates.deleteOne({ _id: id });
    return result.deletedCount === 1;
  }

  async expiredCertificates(before, limit = 100) {
    const docs = await this.certificates.find({ createdAt: { $lt: before } }).limit(limit).toArray();
    return docs.map(fromDoc);
  }
}

function fromDoc({ _id, ...rest }) {
  return { id: _id, ...rest };
}

module.exports = { MongoStore };
