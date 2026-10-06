'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/** Stores recordings as files. For development and single-server deployments. */
class LocalBlobStore {
  constructor(dir) {
    this.root = path.resolve(dir);
  }

  resolve(key) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid blob key');
    return full;
  }

  async put(key, body) {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, { flag: 'wx' }); // never overwrite: recordings are evidence
  }

  async get(key) {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

module.exports = { LocalBlobStore };
