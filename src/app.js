'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { requireAdmin } = require('./security');
const { AppError } = require('./service');
const { certificatePage, notFoundPage, publicCertificate } = require('./views/certificate');

// Browser bundles, served from our own origin (no third-party CDN). The packages don't export
// these paths, so they're located next to each package's resolved entry file in dist/.
const distFile = (pkg, file) => path.join(path.dirname(require.resolve(pkg)), file);
const VENDOR = {
  'rrweb.min.js': [distFile('rrweb', 'rrweb.umd.min.cjs'), 'application/javascript'],
  'rrweb-player.min.js': [distFile('rrweb-player', 'rrweb-player.umd.min.cjs'), 'application/javascript'],
  'rrweb-player.css': [distFile('rrweb-player', 'style.css'), 'text/css'],
};

const limiter = (limit, windowMs = 60_000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false });

/** Express app. All dependencies are injected so tests can run it with in-memory storage. */
function createApp({ config, service, logger = console, extraRoutes }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        // Replays rebuild the recorded page, so its images, fonts and styles must be allowed to load
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:', 'https:'],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null, // so local http:// development works; serve production over HTTPS
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  // ---- Public scripts (loaded by the websites being recorded) ----

  const publicScript = (res, file, type) => {
    res.set({ 'Content-Type': type, 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=3600' });
    res.sendFile(file);
  };
  app.get('/recorder.js', (req, res) => {
    publicScript(res, path.join(__dirname, '..', 'public', 'recorder.js'), 'application/javascript');
  });
  app.get('/vendor/:file', (req, res, next) => {
    const entry = VENDOR[req.params.file];
    if (!entry) return next();
    publicScript(res, entry[0], entry[1]);
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---- Recording API: only for websites in RECORDER_ALLOWED_ORIGINS ----

  const recordingCors = (req, res, next) => {
    if (!config.allowedOrigins.length) {
      return res.status(503).json({ error: 'Recording is disabled: RECORDER_ALLOWED_ORIGINS is not set.' });
    }
    const origin = req.get('origin');
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'This website is not allowed to record.' });
    }
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  const smallJson = express.json({ limit: '64kb' });
  const eventsJson = express.json({ limit: config.maxChunkBytes, verify: (req, res, buf) => { req.rawBytes = buf.length; } });
  const uploadToken = (req) => (/^Bearer\s+(.+)$/i.exec(req.get('authorization') || '') || [])[1];

  app.use('/api/sessions', recordingCors);

  app.post('/api/sessions', limiter(60), smallJson, async (req, res) => {
    const session = await service.createSession({
      origin: req.get('origin'),
      pageUrl: req.body?.pageUrl,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(201).json(session);
  });

  app.post('/api/sessions/:id/events', limiter(600), eventsJson, async (req, res) => {
    const result = await service.appendEvents(req.params.id, uploadToken(req), req.body || {}, req.rawBytes || 0);
    res.json(result);
  });

  app.post('/api/sessions/:id/finalize', limiter(30), smallJson, async (req, res) => {
    const certificate = await service.finalize(req.params.id, uploadToken(req), req.body || {});
    const url = service.certificateUrl(certificate.id);
    logger.info?.(`certificate ${certificate.id} created`);
    res.status(201).json({ certificateId: certificate.id, certificateUrl: url });
  });

  // ---- Certificates: anyone with the (unguessable) link ----

  const certificates = express.Router();
  certificates.use(limiter(120), (req, res, next) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' });
    next();
  });
  const loadCertificate = async (req, res, next) => {
    const certificate = await service.getCertificate(req.params.id);
    if (!certificate) return res.status(404).type('html').send(notFoundPage());
    res.locals.certificate = certificate;
    next();
  };
  certificates.get('/:id', loadCertificate, (req, res) => {
    res.type('html').send(certificatePage(res.locals.certificate, res.locals.nonce));
  });
  certificates.get('/:id/json', loadCertificate, (req, res) => {
    const certificate = res.locals.certificate;
    res.json(publicCertificate(certificate, service.certificateUrl(certificate.id)));
  });
  certificates.get('/:id/recording', loadCertificate, async (req, res) => {
    const body = await service.getRecording(res.locals.certificate);
    res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }).send(body);
  });
  app.use('/c', certificates);

  // ---- Admin API: Authorization: Bearer <ADMIN_TOKEN> ----

  const admin = express.Router();
  admin.use(limiter(120), requireAdmin(config));
  admin.get('/certificates', async (req, res) => {
    const { phone, email, from, to, limit, page } = req.query;
    const result = await service.searchCertificates({ phone, email, from, to, limit, page });
    res.json({
      total: result.total,
      items: result.items.map((c) => ({ ...publicCertificate(c, service.certificateUrl(c.id)), ip: c.ip, userAgent: c.userAgent })),
    });
  });
  admin.get('/certificates/:id', async (req, res) => {
    const certificate = await service.getCertificate(req.params.id);
    if (!certificate) return res.status(404).json({ error: 'Not found' });
    res.json({ ...certificate, url: service.certificateUrl(certificate.id) });
  });
  admin.delete('/certificates/:id', async (req, res) => {
    const deleted = await service.deleteCertificate(req.params.id);
    res.status(deleted ? 204 : 404).end();
  });
  app.use('/api/admin', admin);

  if (extraRoutes) extraRoutes(app);

  // ---- Errors: never leak internals ----

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    logger.error?.('Unhandled error:', err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

module.exports = { createApp };
