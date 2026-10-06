'use strict';
require('dotenv').config();
const { loadConfig } = require('./src/config');
const { build, warnAboutDisabledFeatures } = require('./src/build');

const HOUR = 60 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const { app, service, store } = await build(config);
  warnAboutDisabledFeatures(config);

  const retention = async () => {
    try {
      const removed = await service.runRetention();
      if (removed.sessions || removed.certificates) console.info('Retention cleanup:', removed);
    } catch (err) {
      console.error('Retention cleanup failed:', err);
    }
  };
  await retention();
  setInterval(retention, HOUR).unref();

  const server = app.listen(config.port, () => {
    console.info(`Consent recorder listening on ${config.publicUrl} (storage: ${config.storage}, recordings: ${config.blobs})`);
  });

  const shutdown = () => server.close(async () => {
    await store.close();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
