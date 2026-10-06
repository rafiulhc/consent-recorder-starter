'use strict';
const crypto = require('node:crypto');

/** 128-bit random token, URL-safe (22 chars). Used for certificate ids and upload tokens. */
function randomToken() {
  return crypto.randomBytes(16).toString('base64url');
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const isToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Constant-time comparison; an empty expected value never matches. */
function secretMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(expected));
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

/** Express middleware: admin API access. Responds 503 when ADMIN_TOKEN is not configured. */
function requireAdmin(config) {
  return (req, res, next) => {
    if (!config.adminToken) {
      return res.status(503).json({ error: 'Admin API is disabled: ADMIN_TOKEN is not set.' });
    }
    if (!secretMatches(bearerToken(req), config.adminToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

/** US-centric phone normalization to digits with country code (e.g. 15551234567). */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/**
 * Keyed hash for personal data, so the database never stores phone numbers or emails in
 * plain text but admins can still look certificates up by them. Returns null without a secret.
 */
function piiHash(secret, value) {
  if (!secret || !value) return null;
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

module.exports = {
  randomToken, isToken, sha256, secretMatches, bearerToken, requireAdmin,
  normalizePhone, normalizeEmail, piiHash,
};
