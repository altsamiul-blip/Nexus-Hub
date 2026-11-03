'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const CATEGORIES = [
  'Education',
  'Technology',
  'AI Tools',
  'Development',
  'Productivity',
  'Design',
  'Other',
];

const MEMBER_STATUSES = ['pending', 'approved', 'suspended', 'rejected'];

function candidatePaths() {
  const list = [];
  if (process.env.DB_PATH) list.push(process.env.DB_PATH);
  list.push(path.join(process.cwd(), 'data', 'nexus.db'));
  list.push(path.join(os.tmpdir(), 'nexus-hub', 'nexus.db'));
  return list;
}

let db = null;
let dbPath = null;

function migrate(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','rejected')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      category TEXT NOT NULL,
      icon TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);
    CREATE INDEX IF NOT EXISTS idx_resources_created ON resources(created_at);
  `);
}

const SEED_RESOURCES = [
  {
    name: 'Khan Academy',
    description:
      'Free, world-class practice exercises and instructional videos across maths, science and the humanities.',
    url: 'https://www.khanacademy.org',
    category: 'Education',
    icon: '🎓',
  },
  {
    name: 'MIT OpenCourseWare',
    description:
      'Publish and share the full catalogue of MIT course materials — lectures, notes and assignments — free to the world.',
    url: 'https://ocw.mit.edu',
    category: 'Education',
    icon: '📚',
  },
  {
    name: 'MDN Web Docs',
    description:
      'The reference documentation for the open web: HTML, CSS, JavaScript and browser APIs, maintained by Mozilla and contributors.',
    url: 'https://developer.mozilla.org',
    category: 'Development',
    icon: '📘',
  },
  {
    name: 'GitHub',
    description:
      'Host, review and ship code with the largest collaboration platform for software teams and open source.',
    url: 'https://github.com',
    category: 'Development',
    icon: '🐙',
  },
  {
    name: 'Hugging Face',
    description:
      'Browse, host and deploy open machine-learning models, datasets and inference endpoints in the browser.',
    url: 'https://huggingface.co',
    category: 'AI Tools',
    icon: '🤗',
  },
  {
    name: 'arXiv',
    description:
      'Open-access archive of preprints in physics, mathematics, computer science and quantitative biology.',
    url: 'https://arxiv.org',
    category: 'AI Tools',
    icon: '🧪',
  },
  {
    name: 'Notion',
    description:
      'A flexible workspace for notes, docs, databases and lightweight project tracking for individuals and teams.',
    url: 'https://www.notion.so',
    category: 'Productivity',
    icon: '🗂️',
  },
  {
    name: 'Figma',
    description:
      'Collaborative interface design in the browser with real-time multiplayer, prototyping and design systems.',
    url: 'https://www.figma.com',
    category: 'Design',
    icon: '🎨',
  },
  {
    name: 'Stack Overflow',
    description:
      'Question-and-answer knowledge base for programming problems with peer-reviewed answers and code samples.',
    url: 'https://stackoverflow.com',
    category: 'Technology',
    icon: '💬',
  },
];

function seed(database) {
  const row = database.prepare('SELECT COUNT(*) AS c FROM resources').get();
  if (row && Number(row.c) > 0) return;
  const now = new Date().toISOString();
  const insert = database.prepare(
    `INSERT INTO resources (name, description, url, category, icon, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
  );
  for (const item of SEED_RESOURCES) {
    insert.run(item.name, item.description, item.url, item.category, item.icon, now, now);
  }
}

function open() {
  const errors = [];
  for (const candidate of candidatePaths()) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      const database = new DatabaseSync(candidate);
      migrate(database);
      seed(database);
      db = database;
      dbPath = candidate;
      // Verify the database is actually writable, not just openable.
      database.prepare('SELECT 1 AS ok').get();
      return database;
    } catch (error) {
      errors.push(`${candidate} -> ${error.message}`);
    }
  }
  throw new Error(`Unable to open a writable database. Tried: ${errors.join(' | ')}`);
}

function getDb() {
  if (!db) open();
  return db;
}

function getDbPath() {
  if (!dbPath) open();
  return dbPath;
}

module.exports = {
  CATEGORIES,
  MEMBER_STATUSES,
  SEED_RESOURCES,
  getDb,
  getDbPath,
};
