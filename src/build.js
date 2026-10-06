'use strict';
const { MemoryStore } = require('./store/memory');
const { MongoStore } = require('./store/mongo');
const { LocalBlobStore } = require('./blobs/local');
const { S3BlobStore } = require('./blobs/s3');
const { ConsentService } = require('./service');
const { createApp } = require('./app');

/** Wire up storage, service and app from a config. Shared by server.js and the demo. */
async function build(config, { logger = console, extraRoutes, blobs } = {}) {
  const store = config.storage === 'mongo' ? new MongoStore(config.mongoUri, config.mongoDb) : new MemoryStore();
  await store.init();

  blobs = blobs || (config.blobs === 's3'
    ? new S3BlobStore(config.s3Bucket, config.s3Region)
    : new LocalBlobStore(config.localBlobDir));

  const service = new ConsentService({ config, store, blobs });
  const app = createApp({ config, service, logger, extraRoutes });
  return { app, service, store, blobs };
}

/** Log, once at startup, every feature that is switched off because a setting is missing. */
function warnAboutDisabledFeatures(config, logger = console) {
  if (!config.allowedOrigins.length) logger.warn('RECORDER_ALLOWED_ORIGINS is not set: recording is disabled.');
  if (!config.adminToken) logger.warn('ADMIN_TOKEN is not set: the admin API is disabled.');
  if (!config.piiHashSecret) logger.warn('PII_HASH_SECRET is not set: phone/email are not stored, so search by them is disabled.');
  if (!config.publicUrl.startsWith('https://')) logger.warn(`PUBLIC_URL is ${config.publicUrl}: use HTTPS in production.`);
}

module.exports = { build, warnAboutDisabledFeatures };
