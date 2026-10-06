'use strict';
/**
 * Configuration from environment variables, validated once at startup.
 * Security settings fail closed: missing secrets disable features instead of opening them.
 */

class ConfigError extends Error {}

function number(env, name, fallback, { min = 0 } = {}) {
  const raw = (env[name] ?? '').toString().trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigError(`${name} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

function list(env, name) {
  return (env[name] || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function loadConfig(env = process.env) {
  const storage = (env.STORAGE || 'mongo').toLowerCase();
  const blobs = (env.BLOB_STORAGE || 's3').toLowerCase();
  if (!['mongo', 'memory'].includes(storage)) throw new ConfigError('STORAGE must be "mongo" or "memory"');
  if (!['s3', 'local'].includes(blobs)) throw new ConfigError('BLOB_STORAGE must be "s3" or "local"');
  if (storage === 'mongo' && !env.MONGODB_URI) throw new ConfigError('MONGODB_URI is required when STORAGE=mongo');
  if (blobs === 's3' && !env.S3_BUCKET) throw new ConfigError('S3_BUCKET is required when BLOB_STORAGE=s3');

  const piiSecret = env.PII_HASH_SECRET || '';
  if (piiSecret && piiSecret.length < 32) throw new ConfigError('PII_HASH_SECRET must be at least 32 characters');

  return Object.freeze({
    port: number(env, 'PORT', 3000),
    publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
    trustProxy: number(env, 'TRUST_PROXY_HOPS', 0),

    // Only these websites may record (exact origins, e.g. https://www.example.com)
    allowedOrigins: list(env, 'RECORDER_ALLOWED_ORIGINS'),
    adminToken: env.ADMIN_TOKEN || '',
    piiHashSecret: piiSecret,

    storage,
    mongoUri: env.MONGODB_URI || '',
    mongoDb: env.MONGODB_DB || 'consent',
    blobs,
    s3Bucket: env.S3_BUCKET || '',
    s3Region: env.AWS_REGION || 'us-east-1',
    localBlobDir: env.LOCAL_BLOB_DIR || './data/recordings',

    // Limits
    maxChunkBytes: number(env, 'MAX_CHUNK_BYTES', 2 * 1024 * 1024, { min: 1024 }),
    maxSessionBytes: number(env, 'MAX_SESSION_BYTES', 20 * 1024 * 1024, { min: 1024 }),
    maxSessionMinutes: number(env, 'MAX_SESSION_MINUTES', 60, { min: 1 }),
    retentionDays: number(env, 'RETENTION_DAYS', 5 * 365, { min: 1 }),
    storeIp: (env.STORE_IP ?? 'true').toLowerCase() !== 'false',
  });
}

module.exports = { loadConfig, ConfigError };
