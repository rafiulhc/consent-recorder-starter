'use strict';

/** In-memory recordings, for tests and the demo. */
class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body) {
    if (this.objects.has(key)) throw new Error(`Blob already exists: ${key}`);
    this.objects.set(key, Buffer.from(body));
  }

  async get(key) {
    return this.objects.get(key) || null;
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

module.exports = { MemoryBlobStore };
