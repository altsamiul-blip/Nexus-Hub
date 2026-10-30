'use strict';
// SQLite storage (Node's built-in node:sqlite, so there is nothing native to compile).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const file = process.env.DB_PATH || path.join(__dirname, 'data', 'nexushub.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  is_owner      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','declined')),
  login_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
-- at most one owner (the first admin), enforced by the database itself
CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(is_owner) WHERE is_owner = 1;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_hash  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','declined','expired','cancelled','claimed')),
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  decided_at  INTEGER
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL UNIQUE,
  category   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'Testing' CHECK (status IN ('Working','Testing','Down')),
  logo       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

// Run fn inside one write transaction (rolls back if fn throws).
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

module.exports = { db, tx };
