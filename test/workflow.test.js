'use strict';
/**
 * End-to-end workflow test for NEXUS HUB.
 *
 * Spawns the real HTTP server against a throwaway SQLite database and exercises
 * the complete product workflow against the real backend:
 *
 *   1. register a new member           6. approve the member
 *   2. no email confirmation at all    7. directory access now works
 *   3. sign in immediately             8. suspend -> access blocked
 *   4. account is pending              9. resource add / edit / delete
 *   5. pending member blocked          10. restart server -> data persists
 *
 * Run with:  npm test          (needs Node >= 22.13 for node:sqlite)
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADMIN_EMAIL = 'altsamiul@gmail.com';
const ADMIN_PASSWORD = 'AdminBootstrap123!';
const MEMBER_EMAIL = 'casey.member@example.com';
const MEMBER_PASSWORD = 'MemberPass123!';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
const DB_PATH = path.join(dbDir, 'nexus.db');
const PORT = 3400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

let server = null;
let passed = 0;
const failures = [];

/* ---------------------------------------------------------------- helpers */

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'server.js'],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          PORT: String(PORT),
          HOST: '127.0.0.1',
          DB_PATH,
          ADMIN_EMAIL,
          ADMIN_PASSWORD,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      if (/listening on/i.test(out)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not start in time. Output:\n${out}`));
    }, 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}). Output:\n${out}`));
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.removeAllListeners('exit');
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
    }, 4000).unref();
  });
}

/** Minimal cookie jar: one session per named client. */
function client() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(method, urlPath, body) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + urlPath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookies =
        typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const raw of setCookies) {
        const pair = raw.split(';')[0];
        if (pair.startsWith('nexus_session=')) {
          const value = pair.slice('nexus_session='.length);
          cookie = value ? `nexus_session=${value}` : '';
        }
      }
      let data = null;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return { status: res.status, data, setCookies };
    },
    get(p) {
      return this.request('GET', p);
    },
    post(p, b) {
      return this.request('POST', p, b);
    },
    patch(p, b) {
      return this.request('PATCH', p, b);
    },
    del(p) {
      return this.request('DELETE', p);
    },
  };
}

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u2717 ${name}\n      ${error.message}`);
  }
}

/* ------------------------------------------------------------------- run */

async function main() {
  console.log(`\nNEXUS HUB workflow test\n  db: ${DB_PATH}\n  port: ${PORT}\n`);
  server = await startServer();

  const guest = client();
  const member = client();
  const admin = client();
  const admin2 = client();

  let memberId = null;
  let resourceId = null;

  await step('health endpoint reports a running service', async () => {
    const res = await guest.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  });

  await step('all seven categories are exposed', async () => {
    const res = await guest.get('/api/categories');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.categories, [
      'Education',
      'Technology',
      'AI Tools',
      'Development',
      'Productivity',
      'Design',
      'Other',
    ]);
  });

  let registerData;
  await step('1. a new member can register', async () => {
    const res = await member.post('/api/auth/register', {
      name: 'Casey Member',
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.user.email, MEMBER_EMAIL);
    registerData = res.data;
    memberId = res.data.user.id;
  });

  await step('2. registration sets status = pending and sends no confirmation', async () => {
    // The registration response must never hand back a verification token,
    // OTP or magic link — approval is the only gate.
    const body = JSON.stringify(registerData);
    assert.equal(registerData.user.status, 'pending');
    assert.match(registerData.message, /approval/i);
    assert.doesNotMatch(body, /verif|confirm|otp|token|magic/i);
    const me = await member.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.status, 'pending');
    // No verification token / OTP / magic link is ever issued on registration.
    assert.equal(me.data.user.emailVerified, undefined);
    assert.equal(me.data.user.verificationToken, undefined);
  });

  await step('3. the member is signed in immediately (session cookie issued)', async () => {
    assert.match(member.cookie, /^nexus_session=.+/);
    const me = await member.get('/api/auth/me');
    assert.equal(me.data.user.email, MEMBER_EMAIL);
  });

  await step('4. the pending member cannot reach the directory', async () => {
    const res = await member.get('/api/directory');
    assert.equal(res.status, 403);
    assert.match(res.data.error, /awaiting administrator approval/i);
  });

  await step('4b. the pending member cannot reach admin APIs', async () => {
    const res = await member.get('/api/admin/stats');
    assert.equal(res.status, 403);
  });

  await step('4c. a guest cannot reach the directory', async () => {
    const res = await guest.get('/api/directory');
    assert.equal(res.status, 401);
  });

  await step('5. the administrator signs in with the bootstrapped account', async () => {
    const res = await admin.post('/api/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.user.role, 'admin');
    assert.equal(res.data.user.status, 'approved');
  });

  await step('5b. admin sees the pending member in the member list', async () => {
    const res = await admin.get('/api/admin/members?status=pending');
    assert.equal(res.status, 200);
    const found = res.data.members.find((m) => m.email === MEMBER_EMAIL);
    assert.ok(found, 'pending member not listed');
    assert.equal(found.id, memberId);
  });

  await step('5c. admin member search matches by email', async () => {
    const res = await admin.get('/api/admin/members?q=casey.member');
    assert.equal(res.status, 200);
    assert.equal(res.data.members.length, 1);
  });

  await step('6. the administrator approves the member', async () => {
    const res = await admin.post(`/api/admin/members/${memberId}/status`, { status: 'approved' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.member.status, 'approved');
  });

  await step('7. the approved member can now read the directory', async () => {
    const res = await member.get('/api/directory');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.resources));
    assert.ok(res.data.resources.length > 0, 'seeded directory is empty');
    for (const r of res.data.resources) {
      assert.ok(r.name && r.url && r.category);
      assert.ok(r.createdAt, 'resource missing date added');
    }
  });

  await step('9a. admin adds a resource', async () => {
    const res = await admin.post('/api/admin/resources', {
      name: 'Workflow Test Resource',
      description: 'Created by the automated end-to-end workflow test.',
      url: 'https://example.com/workflow-test',
      category: 'Productivity',
      icon: '\u{1F9EA}',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.resource.category, 'Productivity');
    resourceId = res.data.resource.id;
  });

  await step('9b. the new resource appears in directory search and category filter', async () => {
    const search = await member.get('/api/directory?q=Workflow%20Test');
    assert.equal(search.status, 200);
    assert.equal(search.data.resources.length, 1);
    assert.equal(search.data.resources[0].id, resourceId);

    const filtered = await member.get('/api/directory?category=Productivity');
    assert.ok(filtered.data.resources.some((r) => r.id === resourceId));
  });

  await step('9c. admin edits the resource and the change is readable', async () => {
    const res = await admin.patch(`/api/admin/resources/${resourceId}`, {
      name: 'Workflow Test Resource (edited)',
      description: 'Edited by the automated workflow test.',
      category: 'Design',
      url: 'https://example.com/workflow-test-edited',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.resource.name, 'Workflow Test Resource (edited)');

    const check = await member.get('/api/directory?q=Workflow%20Test');
    assert.equal(check.data.resources[0].name, 'Workflow Test Resource (edited)');
    assert.equal(check.data.resources[0].category, 'Design');
  });

  await step('9d. invalid resource input is rejected server-side', async () => {
    const badUrl = await admin.post('/api/admin/resources', {
      name: 'Bad URL',
      description: 'javascript scheme should never be accepted.',
      url: 'javascript:alert(1)',
      category: 'Other',
    });
    assert.equal(badUrl.status, 400);

    const badCategory = await admin.post('/api/admin/resources', {
      name: 'Bad Category',
      description: 'Unknown category must be rejected.',
      url: 'https://example.com',
      category: 'NotACategory',
    });
    assert.equal(badCategory.status, 400);
  });

  await step('9e. a member cannot create resources', async () => {
    const res = await member.post('/api/admin/resources', {
      name: 'Sneaky',
      description: 'Members must not be able to add resources.',
      url: 'https://example.com',
      category: 'Other',
    });
    assert.equal(res.status, 403);
  });

  await step('9f. admin deletes the resource', async () => {
    const res = await admin.del(`/api/admin/resources/${resourceId}`);
    assert.equal(res.status, 200);
    const check = await member.get('/api/directory?q=Workflow%20Test');
    assert.equal(check.data.resources.length, 0);
  });

  await step('8. suspending the member blocks directory access again', async () => {
    const res = await admin.post(`/api/admin/members/${memberId}/status`, { status: 'suspended' });
    assert.equal(res.status, 200);
    assert.equal(res.data.member.status, 'suspended');

    // The same still-valid session must be refused — the check is server-side
    // and reads the live status, not the token.
    const blocked = await member.get('/api/directory');
    assert.equal(blocked.status, 403);
    assert.match(blocked.data.error, /suspended/i);
  });

  await step('8b. a suspended member cannot sign in again', async () => {
    const fresh = client();
    const res = await fresh.post('/api/auth/login', {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.status, 'suspended');
    const blocked = await fresh.get('/api/directory');
    assert.equal(blocked.status, 403);
  });

  await step('8c. restoring the member re-enables access', async () => {
    const res = await admin.post(`/api/admin/members/${memberId}/status`, { status: 'approved' });
    assert.equal(res.status, 200);
    const allowed = await member.get('/api/directory');
    assert.equal(allowed.status, 200);
  });

  await step('admin stats reflect the live database', async () => {
    const res = await admin.get('/api/admin/stats');
    assert.equal(res.status, 200);
    const s = res.data.stats;
    assert.equal(s.totalMembers, 2);
    assert.equal(s.approvedMembers, 2);
    assert.equal(s.pendingMembers, 0);
    assert.equal(s.suspendedMembers, 0);
    assert.ok(s.totalResources >= 7);
  });

  await step('duplicate registration is refused', async () => {
    const res = await guest.post('/api/auth/register', {
      name: 'Casey Copy',
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
    });
    assert.equal(res.status, 409);
  });

  await step('short passwords are refused', async () => {
    const res = await guest.post('/api/auth/register', {
      name: 'Short Pass',
      email: 'short.pass@example.com',
      password: 'abc',
    });
    assert.equal(res.status, 400);
  });

  /* ---------------- 10. persistence across a real server restart --------- */

  await step('9g. a resource created before the restart survives it', async () => {
    const res = await admin.post('/api/admin/resources', {
      name: 'Persistence Probe',
      description: 'Must still exist after the server restarts.',
      url: 'https://example.com/persistence',
      category: 'Technology',
    });
    assert.equal(res.status, 201);
    resourceId = res.data.resource.id;
  });

  await stopServer();
  server = await startServer();

  await step('10. data persists after a full server restart (real SQLite file)', async () => {
    const login = await admin2.post('/api/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200, 'admin login failed after restart');
    assert.equal(login.data.user.role, 'admin');

    const persisted = await admin2.get('/api/directory?q=Persistence');
    assert.equal(persisted.status, 200);
    assert.equal(persisted.data.resources.length, 1);
    assert.equal(persisted.data.resources[0].id, resourceId);

    const members = await admin2.get('/api/admin/members?q=casey.member');
    assert.equal(members.data.members[0].status, 'approved');

    const stats = await admin2.get('/api/admin/stats');
    assert.equal(stats.data.stats.totalMembers, 2);
  });

  await step('server-rendered SPA routes all serve the application shell', async () => {
    for (const route of ['/', '/login', '/register', '/directory', '/admin', '/account']) {
      const res = await fetch(BASE + route);
      const html = await res.text();
      assert.equal(res.status, 200, `${route} returned ${res.status}`);
      assert.match(html, /NEXUS HUB/i, `${route} did not serve the app shell`);
    }
  });

  await step('account settings update the member name', async () => {
    const fresh = client();
    await fresh.post('/api/auth/login', { email: MEMBER_EMAIL, password: MEMBER_PASSWORD });
    const res = await fresh.patch('/api/account', { name: 'Casey Renamed' });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.name, 'Casey Renamed');
  });

  await stopServer();

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed\n`);
  if (failures.length) {
    for (const f of failures) {
      console.error(`FAILED: ${f.name}\n${f.error.stack || f.error.message}\n`);
    }
    process.exitCode = 1;
  }
  fs.rmSync(dbDir, { recursive: true, force: true });
}

main().catch(async (error) => {
  console.error('\nTest harness error:', error);
  await stopServer().catch(() => {});
  process.exitCode = 1;
});
