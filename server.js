'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { getDb, getDbPath, CATEGORIES } = require('./db');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  purgeExpiredSessions,
  userForToken,
  SESSION_TTL_MS,
} = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const COOKIE_NAME = 'nexus_session';
const PUBLIC_DIR = path.join(__dirname, 'public');

const db = getDb();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function sessionCookie(value, req, maxAgeSeconds) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function str(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validateEmail(email) {
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return 'Enter a valid email address.';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) return 'Password is too long.';
  return null;
}

function validateName(name) {
  if (!name || name.length < 2) return 'Please enter your name (2 characters minimum).';
  return null;
}

function normalizeUrl(raw) {
  const value = str(raw, 500);
  if (!value) return { error: 'Website URL is required.' };
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { error: 'Enter a valid website URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http and https links are allowed.' };
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return { error: 'Enter a valid website URL.' };
  }
  return { url: parsed.toString() };
}

function serializeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at ?? row.createdAt ?? null,
    approvedAt: row.approved_at ?? row.approvedAt ?? null,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt ?? null,
  };
}

function serializeResource(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    category: row.category,
    icon: row.icon || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ *
 * Simple in-memory guard rails for credential endpoints
 * ------------------------------------------------------------------ */

const attempts = new Map();

function attemptKey(req, email) {
  const ip = req.socket.remoteAddress || 'unknown';
  return `${ip}|${email || '-'}`;
}

function tooManyAttempts(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= 10;
}

function noteAttempt(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return;
  }
  entry.count += 1;
}

function clearAttempts(key) {
  attempts.delete(key);
}

/* ------------------------------------------------------------------ *
 * Bootstrap: administrator account created server-side from env vars
 * ------------------------------------------------------------------ */

function bootstrapAdmin() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL || '');
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email) {
    console.warn('[bootstrap] ADMIN_EMAIL not set — no administrator provisioned.');
    return;
  }
  if (validateEmail(email)) {
    console.warn(`[bootstrap] ADMIN_EMAIL "${email}" is not a valid email — skipping.`);
    return;
  }
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      "UPDATE users SET role = 'admin', status = 'approved', updated_at = ?, approved_at = COALESCE(approved_at, ?) WHERE id = ?"
    ).run(now, now, existing.id);
    console.log(`[bootstrap] ensured administrator privileges for ${email}`);
    return;
  }
  if (validatePassword(password)) {
    console.warn(
      '[bootstrap] ADMIN_PASSWORD is missing or shorter than 8 characters — administrator not created yet.'
    );
    return;
  }
  db.prepare(
    `INSERT INTO users (name, email, password_hash, role, status, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, 'admin', 'approved', ?, ?, ?)`
  ).run('Administrator', email, hashPassword(password), now, now, now);
  console.log(`[bootstrap] created administrator ${email}`);
}

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */

function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return userForToken(db, token);
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendError(res, 401, 'You need to sign in first.');
    return null;
  }
  return user;
}

/** Approved members and administrators only. */
function requireApproved(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin' && user.status !== 'approved') {
    const message =
      user.status === 'suspended'
        ? 'Your account is suspended. Contact the administrator.'
        : user.status === 'rejected'
          ? 'Your registration was not approved.'
          : 'Your account is awaiting administrator approval.';
    sendError(res, 403, message);
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendError(res, 403, 'Administrator access required.');
    return null;
  }
  return user;
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  const name = str(body.name, 80);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  const nameError = validateName(name);
  if (nameError) return sendError(res, 400, nameError);
  const emailError = validateEmail(email);
  if (emailError) return sendError(res, 400, emailError);
  const passwordError = validatePassword(password);
  if (passwordError) return sendError(res, 400, passwordError);

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return sendError(res, 409, 'An account with that email already exists. Try signing in.');
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'pending', ?, ?)`
    )
    .run(name, email, hashPassword(password), now, now);

  const userId = Number(info.lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // Sign the member in immediately. No email confirmation step exists anywhere
  // in this flow: the account exists as soon as this insert commits.
  const session = createSession(db, userId);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, userId);

  sendJson(
    res,
    201,
    {
      user: serializeUser({ ...user, last_login_at: now }),
      message: 'Account created. Administrator approval is required before directory access.',
    },
    { 'Set-Cookie': sessionCookie(session.token, req, Math.floor(SESSION_TTL_MS / 1000)) }
  );
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const key = attemptKey(req, email);

  if (tooManyAttempts(key)) {
    return sendError(res, 429, 'Too many attempts. Please wait a few minutes and try again.');
  }

  const row = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
  if (!row || !verifyPassword(password, row.password_hash)) {
    noteAttempt(key);
    return sendError(res, 401, 'Incorrect email or password.');
  }
  if (row.status === 'rejected') {
    return sendError(res, 403, 'This registration was not approved by the administrator.');
  }

  clearAttempts(key);
  const now = new Date().toISOString();
  const session = createSession(db, row.id);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);

  sendJson(
    res,
    200,
    { user: serializeUser({ ...row, last_login_at: now }) },
    { 'Set-Cookie': sessionCookie(session.token, req, Math.floor(SESSION_TTL_MS / 1000)) }
  );
}

function handleLogout(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  destroySession(db, token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, 0) });
}

function handleMe(req, res) {
  const user = currentUser(req);
  sendJson(res, 200, { user: user || null });
}

function handleDirectory(req, res, url) {
  const user = requireApproved(req, res);
  if (!user) return;

  const q = str(url.searchParams.get('q'), 120);
  const category = str(url.searchParams.get('category'), 40);
  const clauses = [];
  const params = [];

  if (q) {
    clauses.push('(name LIKE ? OR description LIKE ? OR url LIKE ?)');
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like);
  }
  if (category && CATEGORIES.includes(category)) {
    clauses.push('category = ?');
    params.push(category);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM resources ${where.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")}
       ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all(...params);

  sendJson(res, 200, {
    resources: rows.map(serializeResource),
    total: rows.length,
    categories: CATEGORIES,
    viewer: { name: user.name, role: user.role, status: user.status },
  });
}

function handleAdminStats(req, res) {
  if (!requireAdmin(req, res)) return;
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params).c);
  const stats = {
    totalMembers: count('SELECT COUNT(*) AS c FROM users'),
    pendingMembers: count("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'"),
    approvedMembers: count("SELECT COUNT(*) AS c FROM users WHERE status = 'approved'"),
    suspendedMembers: count("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'"),
    rejectedMembers: count("SELECT COUNT(*) AS c FROM users WHERE status = 'rejected'"),
    totalResources: count('SELECT COUNT(*) AS c FROM resources'),
  };
  const byCategory = db
    .prepare('SELECT category, COUNT(*) AS c FROM resources GROUP BY category')
    .all()
    .reduce((acc, row) => {
      acc[row.category] = Number(row.c);
      return acc;
    }, {});
  sendJson(res, 200, { stats, byCategory, categories: CATEGORIES });
}

function handleAdminMembers(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const status = str(url.searchParams.get('status'), 20) || 'all';
  const q = str(url.searchParams.get('q'), 120);
  const clauses = [];
  const params = [];
  if (['pending', 'approved', 'suspended', 'rejected'].includes(status)) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push('(name LIKE ? OR email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM users ${where} ORDER BY datetime(created_at) DESC, id DESC`)
    .all(...params);
  sendJson(res, 200, { members: rows.map(serializeUser), filter: status });
}

async function handleMemberStatus(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const body = await readJson(req);
  const status = str(body.status, 20);
  if (!['approved', 'suspended', 'pending', 'rejected'].includes(status)) {
    return sendError(res, 400, 'Unsupported member status.');
  }
  const member = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!member) return sendError(res, 404, 'Member not found.');
  if (member.role === 'admin' && status !== 'approved') {
    return sendError(res, 400, 'Administrator accounts cannot be suspended.');
  }
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE users SET status = ?, updated_at = ?, approved_at = CASE WHEN ? = \'approved\' THEN COALESCE(approved_at, ?) ELSE approved_at END WHERE id = ?'
  ).run(status, now, status, now, id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  sendJson(res, 200, { member: serializeUser(updated) });
}

function resourceInput(body) {
  const name = str(body.name, 120);
  const description = str(body.description, 600);
  const category = str(body.category, 40);
  const icon = str(body.icon, 8);
  const urlResult = normalizeUrl(body.url);

  if (!name) return { error: 'Resource name is required.' };
  if (description.length < 4) return { error: 'Please add a short description.' };
  if (!CATEGORIES.includes(category)) return { error: 'Choose a valid category.' };
  if (urlResult.error) return { error: urlResult.error };
  if (icon && !/^\p{Extended_Pictographic}+$/u.test(icon)) {
    return { error: 'Icon must be a single emoji.' };
  }
  return { name, description, category, icon: icon || null, url: urlResult.url };
}

async function handleCreateResource(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJson(req);
  const input = resourceInput(body);
  if (input.error) return sendError(res, 400, input.error);

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO resources (name, description, url, category, icon, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.name, input.description, input.url, input.category, input.icon, admin.id, now, now);
  const created = db.prepare('SELECT * FROM resources WHERE id = ?').get(Number(info.lastInsertRowid));
  sendJson(res, 201, { resource: serializeResource(created) });
}

async function handleUpdateResource(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const existing = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
  if (!existing) return sendError(res, 404, 'Resource not found.');
  const body = await readJson(req);
  const input = resourceInput({
    name: body.name ?? existing.name,
    description: body.description ?? existing.description,
    url: body.url ?? existing.url,
    category: body.category ?? existing.category,
    icon: body.icon === undefined ? existing.icon ?? '' : body.icon,
  });
  if (input.error) return sendError(res, 400, input.error);

  db.prepare(
    'UPDATE resources SET name = ?, description = ?, url = ?, category = ?, icon = ?, updated_at = ? WHERE id = ?'
  ).run(input.name, input.description, input.url, input.category, input.icon, new Date().toISOString(), id);
  const updated = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
  sendJson(res, 200, { resource: serializeResource(updated) });
}

function handleDeleteResource(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const existing = db.prepare('SELECT id FROM resources WHERE id = ?').get(id);
  if (!existing) return sendError(res, 404, 'Resource not found.');
  db.prepare('DELETE FROM resources WHERE id = ?').run(id);
  sendJson(res, 200, { ok: true, id: Number(id) });
}

function handleAdminResources(req, res) {
  if (!requireAdmin(req, res)) return;
  const rows = db
    .prepare('SELECT * FROM resources ORDER BY datetime(created_at) DESC, id DESC')
    .all();
  sendJson(res, 200, { resources: rows.map(serializeResource), categories: CATEGORIES });
}

async function handleAccountUpdate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJson(req);
  const name = str(body.name, 80);
  const nameError = validateName(name);
  if (nameError) return sendError(res, 400, nameError);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(name, now, user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: serializeUser(updated) });
}

async function handlePasswordChange(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJson(req);
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    return sendError(res, 400, 'Current password is incorrect.');
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) return sendError(res, 400, passwordError);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(newPassword),
    new Date().toISOString(),
    user.id
  );
  sendJson(res, 200, { ok: true, message: 'Password updated.' });
}

/* ------------------------------------------------------------------ *
 * Static assets + SPA fallback
 * ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  if (pathname.includes('..')) return sendError(res, 400, 'Bad path.');
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 400, 'Bad path.');

  fs.readFile(filePath, (err, data) => {
    if (err) return serveSpa(res);
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

let indexHtmlPromise = null;
function serveSpa(res) {
  if (!indexHtmlPromise) {
    indexHtmlPromise = fs.promises.readFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  indexHtmlPromise
    .then((html) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
    })
    .catch((error) => {
      console.error('[static] unable to read index.html', error.message);
      sendError(res, 500, 'Application shell unavailable.');
    });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const SPA_ROUTES = new Set(['/', '/login', '/register', '/directory', '/admin', '/account', '/pending']);

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          service: 'nexus-hub',
          database: 'sqlite',
          uptime: Math.round(process.uptime()),
        });
      }
      if (pathname === '/api/categories' && method === 'GET') {
        return sendJson(res, 200, { categories: CATEGORIES });
      }
      if (pathname === '/api/public/stats' && method === 'GET') {
        // Aggregate counts only. No member names, emails or resource rows leak
        // to unauthenticated visitors.
        const total = Number(db.prepare('SELECT COUNT(*) AS c FROM resources').get().c);
        const members = Number(
          db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'approved'").get().c
        );
        return sendJson(res, 200, { resources: total, approvedMembers: members });
      }
      if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(req, res);
      if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(req, res);
      if (pathname === '/api/auth/logout' && method === 'POST') return handleLogout(req, res);
      if (pathname === '/api/auth/me' && method === 'GET') return handleMe(req, res);
      if (pathname === '/api/directory' && method === 'GET') return handleDirectory(req, res, url);
      if (pathname === '/api/account' && method === 'PATCH') return await handleAccountUpdate(req, res);
      if (pathname === '/api/account/password' && method === 'POST')
        return await handlePasswordChange(req, res);

      if (pathname === '/api/admin/stats' && method === 'GET') return handleAdminStats(req, res);
      if (pathname === '/api/admin/members' && method === 'GET')
        return handleAdminMembers(req, res, url);
      if (pathname === '/api/admin/resources' && method === 'GET')
        return handleAdminResources(req, res);
      if (pathname === '/api/admin/resources' && method === 'POST')
        return await handleCreateResource(req, res);

      const memberMatch = pathname.match(/^\/api\/admin\/members\/(\d+)\/status$/);
      if (memberMatch && method === 'POST')
        return await handleMemberStatus(req, res, Number(memberMatch[1]));

      const resourceMatch = pathname.match(/^\/api\/admin\/resources\/(\d+)$/);
      if (resourceMatch) {
        const id = Number(resourceMatch[1]);
        if (method === 'PATCH' || method === 'PUT') return await handleUpdateResource(req, res, id);
        if (method === 'DELETE') return handleDeleteResource(req, res, id);
      }

      return sendError(res, 404, 'Unknown API endpoint.');
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error('[api]', error);
      if (!res.headersSent) sendError(res, status, error.message || 'Unexpected server error.');
      return;
    }
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed.');
  }

  if (pathname !== '/' && /\/$/.test(pathname)) {
    res.writeHead(301, { Location: pathname.replace(/\/+$/, '') });
    return res.end();
  }

  if (SPA_ROUTES.has(pathname) || pathname === '/index.html') {
    return serveStatic(req, res, pathname === '/index.html' ? '/' : pathname);
  }

  if (path.extname(pathname)) return serveStatic(req, res, pathname);
  return serveSpa(res);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

purgeExpiredSessions(db);
bootstrapAdmin();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[fatal]', error);
    if (!res.headersSent) sendError(res, 500, 'Unexpected server error.');
  });
});

server.on('error', (error) => {
  console.error('[server] error', error);
  process.exitCode = 1;
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`NEXUS HUB listening on http://${HOST}:${PORT}`);
    console.log(`Database: ${getDbPath()}`);
  });
}

module.exports = { server, app: route, db, bootstrapAdmin };
