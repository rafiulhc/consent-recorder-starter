'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../src/config');
const { normalizePhone, normalizeEmail, piiHash, secretMatches, randomToken, isToken } = require('../src/security');

const MINIMAL = { STORAGE: 'memory', BLOB_STORAGE: 'local' };

describe('config', () => {
  it('is safe by default: recording, admin API and PII hashing are all off', () => {
    const config = loadConfig(MINIMAL);
    assert.deepEqual(config.allowedOrigins, []);
    assert.equal(config.adminToken, '');
    assert.equal(config.piiHashSecret, '');
  });

  it('requires a database and bucket in production mode', () => {
    assert.throws(() => loadConfig({}), /MONGODB_URI/);
    assert.throws(() => loadConfig({ MONGODB_URI: 'mongodb://x' }), /S3_BUCKET/);
    assert.ok(loadConfig({ MONGODB_URI: 'mongodb://x', S3_BUCKET: 'b' }));
  });

  it('parses allowed origins and drops trailing slashes', () => {
    const config = loadConfig({ ...MINIMAL, RECORDER_ALLOWED_ORIGINS: 'https://a.com/, https://b.com' });
    assert.deepEqual(config.allowedOrigins, ['https://a.com', 'https://b.com']);
  });

  it('rejects a weak PII secret and invalid numbers', () => {
    assert.throws(() => loadConfig({ ...MINIMAL, PII_HASH_SECRET: 'short' }), ConfigError);
    assert.throws(() => loadConfig({ ...MINIMAL, RETENTION_DAYS: 'forever' }), /RETENTION_DAYS/);
    assert.throws(() => loadConfig({ ...MINIMAL, STORAGE: 'sqlite' }), /STORAGE/);
  });
});

describe('security helpers', () => {
  it('normalizes phone numbers, and refuses partial ones', () => {
    assert.equal(normalizePhone('(555) 123-4567'), '15551234567');
    assert.equal(normalizePhone('+1 555.123.4567'), '15551234567');
    assert.equal(normalizePhone('+44 20 7946 0958'), '442079460958');
    assert.equal(normalizePhone('4567'), null);
    assert.equal(normalizePhone(''), null);
  });

  it('normalizes emails', () => {
    assert.equal(normalizeEmail('  Lead@Example.COM '), 'lead@example.com');
    assert.equal(normalizeEmail('not-an-email'), null);
  });

  it('hashes personal data with a key, and only with a key', () => {
    assert.equal(piiHash('', '15551234567'), null);
    assert.notEqual(piiHash('a'.repeat(32), '1'), piiHash('b'.repeat(32), '1'));
    assert.match(piiHash('a'.repeat(32), '1'), /^[0-9a-f]{64}$/);
  });

  it('compares secrets safely, and an empty secret never matches', () => {
    assert.equal(secretMatches('abc', 'abc'), true);
    assert.equal(secretMatches('abd', 'abc'), false);
    assert.equal(secretMatches('', ''), false);
    assert.equal(secretMatches(undefined, 'abc'), false);
  });

  it('makes 128-bit URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, randomToken));
    assert.equal(tokens.size, 1000);
    assert.ok([...tokens].every(isToken));
    assert.equal(isToken('../../etc/passwd'), false);
  });
});
