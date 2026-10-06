'use strict';
/**
 * Try the whole flow locally with no database, S3 or accounts:
 *   npm run demo   →   open http://localhost:3000/demo
 * Everything is kept in memory and disappears when you stop the demo.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { loadConfig } = require('../src/config');
const { build } = require('../src/build');
const { MemoryBlobStore } = require('../src/blobs/memory');
const { escapeHtml } = require('../src/views/certificate');

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_TOKEN = crypto.randomBytes(24).toString('base64url');

function demoRoutes(app) {
  app.get('/', (req, res) => res.redirect('/demo'));
  app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, '..', 'demo', 'form.html')));
  app.get('/demo/demo.css', (req, res) => res.sendFile(path.join(__dirname, '..', 'demo', 'demo.css')));

  // Stands in for your own backend: it receives the form, including the certificate link
  app.post('/demo/submit', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    const url = String(req.body.consent_certificate_url || '');
    const valid = url.startsWith(`${ORIGIN}/c/`);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thanks</title><link rel="stylesheet" href="/demo/demo.css">
<main class="demo"><h1>Thanks! Your form was received.</h1>
${valid
    ? `<p class="lead">Your backend received this certificate link with the lead:</p><p><code>${escapeHtml(url)}</code></p>
       <p><a class="button" href="${escapeHtml(url)}">Open the consent certificate →</a></p>`
    : '<p class="lead">No certificate was attached. Check the browser console for recorder errors.</p>'}
<p><a href="/demo">← Submit another</a></p></main>`);
  });
}

async function main() {
  const config = loadConfig({
    PORT: String(PORT),
    PUBLIC_URL: ORIGIN,
    STORAGE: 'memory',
    BLOB_STORAGE: 'local',
    RECORDER_ALLOWED_ORIGINS: ORIGIN,
    ADMIN_TOKEN,
    PII_HASH_SECRET: crypto.randomBytes(32).toString('hex'),
  });
  const { app } = await build(config, { blobs: new MemoryBlobStore(), extraRoutes: demoRoutes });
  app.listen(PORT, () => {
    console.log(`
  Demo running (everything in memory):

    Form:       ${ORIGIN}/demo
    Admin API:  curl -H "Authorization: Bearer ${ADMIN_TOKEN}" ${ORIGIN}/api/admin/certificates
`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
