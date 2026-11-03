'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(db, userId) {
  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(hashToken(token), userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

/** Resolve the live user for a session token; status is always read fresh from the DB. */
function userForToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at, u.approved_at, u.last_login_at,
              s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(hashToken(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    destroySession(db, token);
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    lastLoginAt: row.last_login_at,
  };
}

module.exports = {
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  purgeExpiredSessions,
  userForToken,
  hashToken,
};
