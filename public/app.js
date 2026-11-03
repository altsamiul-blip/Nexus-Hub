'use strict';

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

const CATEGORY_FALLBACK = [
  'Education',
  'Technology',
  'AI Tools',
  'Development',
  'Productivity',
  'Design',
  'Other',
];

const state = {
  user: null,
  booted: false,
  categories: CATEGORY_FALLBACK.slice(),
  directory: { q: '', category: '', resources: [], loading: false },
  admin: { tab: 'approvals', members: [], status: 'all', q: '', resources: [], editingId: null },
};

const view = document.getElementById('view');
const toasts = document.getElementById('toasts');

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function toast(message, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function spinner() {
  view.innerHTML = '<div class="spinner" role="status" aria-label="Loading"></div>';
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const ROUTES = ['/', '/login', '/register', '/pending', '/directory', '/admin', '/account'];

function currentPath() {
  const p = location.pathname.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

function isPrivileged(user) {
  return Boolean(user) && (user.role === 'admin' || user.status === 'approved');
}

function syncChrome() {
  const user = state.user;
  const navAdmin = document.querySelector('[data-nav="admin"]');
  const navAccount = document.querySelector('[data-nav="account"]');
  const navDirectory = document.querySelector('[data-nav="directory"]');
  const actions = document.getElementById('header-actions');

  if (navAdmin) navAdmin.hidden = !(user && user.role === 'admin');
  if (navAccount) navAccount.hidden = !user;
  if (navDirectory) navDirectory.hidden = !user;

  if (user) {
    actions.innerHTML = `
      <div class="session-chip">
        <span class="avatar">${esc(initials(user.name))}</span>
        <span class="who">${esc(user.name)}</span>
      </div>
      <button class="btn btn-ghost btn-sm" id="logout-btn" type="button">Sign out</button>
    `;
    const logout = document.getElementById('logout-btn');
    if (logout) logout.addEventListener('click', doLogout);
  } else {
    actions.innerHTML = `
      <a class="btn btn-ghost btn-sm" href="/login" data-link>Sign in</a>
      <a class="btn btn-primary btn-sm" href="/register" data-link>Create account</a>
    `;
  }

  const path = currentPath();
  document.querySelectorAll('.site-nav a').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('href') === path);
  });

  document.title =
    path === '/' ? 'NEXUS HUB — Curated resources. One place.' : `NEXUS HUB — ${path.slice(1)}`;
}

async function doLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* session already gone */ }
  state.user = null;
  toast('Signed out.');
  navigate('/');
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function viewLanding() {
  const approved = isPrivileged(state.user);
  const ctaPrimary = approved
    ? `<a class="btn btn-primary" href="/directory" data-link>Open the directory</a>`
    : state.user
      ? `<a class="btn btn-primary" href="/pending" data-link>View approval status</a>`
      : `<a class="btn btn-primary" href="/register" data-link>Request membership</a>`;
  const ctaSecondary = state.user
    ? ''
    : `<a class="btn btn-ghost" href="/login" data-link>Sign in</a>`;

  view.innerHTML = `
    <section class="hero">
      <span class="eyebrow"><span class="pulse"></span>Members-only directory</span>
      <h1>Curated resources.<br /><span class="accent">One place.</span></h1>
      <p class="lede">
        NEXUS HUB collects the best education, technology, AI and design resources on the web into a
        single, distraction-free library. Membership is reviewed by an administrator — no email
        confirmation, no verification links, just a real account and a human approval.
      </p>
      <div class="hero-actions">
        ${ctaPrimary}
        ${ctaSecondary}
      </div>
      <div class="hero-note">
        <span class="pulse" style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block"></span>
        Register with email and password — sign in immediately, no email confirmation.
      </div>

      <div class="stat-strip">
        <div class="strip-item">
          <strong id="stat-resources">—</strong>
          <span>Curated resources</span>
        </div>
        <div class="strip-item">
          <strong>${state.categories.length}</strong>
          <span>Categories</span>
        </div>
        <div class="strip-item">
          <strong>Approval</strong>
          <span>Membership model</span>
        </div>
      </div>
    </section>

    <section class="feature-grid">
      <article class="feature">
        <div class="icon">🔐</div>
        <h3>Real backend accounts</h3>
        <p>Email and password authentication against a persistent SQLite database with hashed credentials and server-side sessions.</p>
      </article>
      <article class="feature">
        <div class="icon">✅</div>
        <h3>Administrator approval</h3>
        <p>New registrations land in a pending queue. An administrator approves, rejects or suspends members — enforced on every request.</p>
      </article>
      <article class="feature">
        <div class="icon">🗂️</div>
        <h3>Curated library</h3>
        <p>Search across the whole catalogue, filter by category and open any resource in a new tab. Everything is stored server-side.</p>
      </article>
    </section>

    <div class="category-ribbon">
      <span class="label">Categories</span>
      ${state.categories.map((c) => `<span class="chip-static">${esc(c)}</span>`).join('')}
    </div>
  `;

  api('/api/public/stats')
    .then((data) => {
      const el = document.getElementById('stat-resources');
      if (el) el.textContent = String(data.resources ?? '—');
    })
    .catch(() => { /* landing stays usable without live count */ });
}

function authShell(title, subtitle, body) {
  return `
    <div class="auth-wrap">
      <div class="card">
        <div class="card-head">
          <h1>${esc(title)}</h1>
          <p>${esc(subtitle)}</p>
        </div>
        ${body}
      </div>
    </div>
  `;
}

function viewLogin() {
  if (state.user) {
    navigate(isPrivileged(state.user) ? '/directory' : '/pending', { replace: true });
    return;
  }
  view.innerHTML = authShell(
    'Welcome back',
    'Sign in with your email and password.',
    `
      <div id="login-error" hidden></div>
      <form id="login-form" novalidate>
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com" />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Your password" />
        </div>
        <div class="form-foot">
          <button class="btn btn-primary btn-block" type="submit" id="login-submit">Sign in</button>
          <p class="switch-line">No account yet? <a href="/register" data-link>Request membership</a></p>
        </div>
      </form>
    `
  );

  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: form.email.value,
          password: form.password.value,
        }),
      });
      state.user = data.user;
      syncChrome();
      toast(`Welcome back, ${data.user.name.split(' ')[0]}.`);
      navigate(isPrivileged(data.user) ? '/directory' : '/pending');
    } catch (error) {
      errorBox.hidden = false;
      errorBox.className = 'alert';
      errorBox.textContent = error.message;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
}

function viewRegister() {
  if (state.user) {
    navigate(isPrivileged(state.user) ? '/directory' : '/pending', { replace: true });
    return;
  }
  view.innerHTML = authShell(
    'Request membership',
    'Create an account with email and password. No email confirmation is required.',
    `
      <div id="register-error" hidden></div>
      <form id="register-form" novalidate>
        <div class="field">
          <label for="reg-name">Full name</label>
          <input id="reg-name" name="name" type="text" autocomplete="name" required placeholder="Ada Lovelace" />
        </div>
        <div class="field">
          <label for="reg-email">Email</label>
          <input id="reg-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com" />
        </div>
        <div class="field">
          <label for="reg-password">Password</label>
          <input id="reg-password" name="password" type="password" autocomplete="new-password" required placeholder="At least 8 characters" />
          <span class="hint">Minimum 8 characters.</span>
        </div>
        <div class="field">
          <label for="reg-confirm">Confirm password</label>
          <input id="reg-confirm" name="confirm" type="password" autocomplete="new-password" required placeholder="Repeat your password" />
        </div>
        <div class="form-foot">
          <button class="btn btn-primary btn-block" type="submit" id="register-submit">Create account</button>
          <p class="switch-line">Already a member? <a href="/login" data-link>Sign in</a></p>
        </div>
      </form>
    `
  );

  const form = document.getElementById('register-form');
  const errorBox = document.getElementById('register-error');
  const submit = document.getElementById('register-submit');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    if (form.password.value !== form.confirm.value) {
      errorBox.hidden = false;
      errorBox.className = 'alert';
      errorBox.textContent = 'Passwords do not match.';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Creating account…';
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value,
          email: form.email.value,
          password: form.password.value,
        }),
      });
      state.user = data.user;
      syncChrome();
      toast('Account created. You are signed in.');
      navigate('/pending');
    } catch (error) {
      errorBox.hidden = false;
      errorBox.className = 'alert';
      errorBox.textContent = error.message;
      submit.disabled = false;
      submit.textContent = 'Create account';
    }
  });
}

function statusScreen({ icon, title, message, badge, extra = '' }) {
  const user = state.user;
  return `
    <div class="status-screen">
      <div class="status-icon">${icon}</div>
      <h1>${esc(title)}</h1>
      <p>${esc(message)}</p>
      ${user ? `<span class="badge ${esc(user.status)}">${esc(badge || user.status)}</span>` : ''}
      ${
        user
          ? `<div class="status-meta">
              <div class="meta-row"><span>Name</span><span>${esc(user.name)}</span></div>
              <div class="meta-row"><span>Email</span><span>${esc(user.email)}</span></div>
              <div class="meta-row"><span>Status</span><span>${esc(user.status)}</span></div>
              <div class="meta-row"><span>Registered</span><span>${formatDate(user.createdAt)}</span></div>
            </div>`
          : ''
      }
      <div class="hero-actions" style="justify-content:center">
        <button class="btn btn-primary" id="refresh-status" type="button">Refresh status</button>
        <a class="btn btn-ghost" href="/account" data-link>Account settings</a>
        <button class="btn btn-ghost" id="status-logout" type="button">Sign out</button>
      </div>
      ${extra}
    </div>
  `;
}

function viewPending() {
  const user = state.user;
  if (!user) {
    navigate('/login', { replace: true });
    return;
  }
  if (user.role === 'admin' || user.status === 'approved') {
    navigate('/directory', { replace: true });
    return;
  }

  if (user.status === 'suspended') {
    view.innerHTML = statusScreen({
      icon: '⛔',
      title: 'Account suspended',
      message:
        'Access to the resource directory has been suspended by an administrator. Reach out to the administrator if you believe this is a mistake.',
      badge: 'suspended',
    });
  } else if (user.status === 'rejected') {
    view.innerHTML = statusScreen({
      icon: '🚫',
      title: 'Registration not approved',
      message:
        'An administrator reviewed your request and did not approve this account. You can create a new request with a different email.',
      badge: 'rejected',
    });
  } else {
    view.innerHTML = statusScreen({
      icon: '⏳',
      title: 'Approval pending',
      message:
        'Your account is active and signed in, but an administrator still needs to approve directory access. No email confirmation is involved — check back here after approval.',
      badge: 'pending',
      extra: `<p class="inline-note" style="margin-top:18px">Share the email address on this account with the administrator so they can find you in the member queue.</p>`,
    });
  }

  const refresh = document.getElementById('refresh-status');
  if (refresh) {
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.textContent = 'Checking…';
      try {
        const data = await api('/api/auth/me');
        state.user = data.user;
        syncChrome();
        if (data.user && (data.user.role === 'admin' || data.user.status === 'approved')) {
          toast('You have been approved. Welcome!');
          navigate('/directory');
          return;
        }
        toast(
          data.user && data.user.status === 'suspended'
            ? 'Your account is suspended.'
            : 'Still awaiting administrator approval.',
          'error'
        );
        render();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        if (document.body.contains(refresh)) {
          refresh.disabled = false;
          refresh.textContent = 'Refresh status';
        }
      }
    });
  }

  const logout = document.getElementById('status-logout');
  if (logout) logout.addEventListener('click', doLogout);
}

function viewBlocked(user) {
  view.innerHTML = statusScreen({
    icon: user.status === 'suspended' ? '⛔' : '⏳',
    title: user.status === 'suspended' ? 'Access suspended' : 'Approval pending',
    message:
      user.status === 'suspended'
        ? 'Your account is suspended, so the directory and admin dashboard are unavailable.'
        : 'The directory unlocks once an administrator approves your membership.',
  });
}

async function viewDirectory() {
  const user = state.user;
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Resource directory</h1>
        <p>Approved members only · ${esc(user.name)}</p>
      </div>
      <span class="badge ${esc(user.status)}">${esc(user.role === 'admin' ? 'administrator' : user.status)}</span>
    </div>

    <div class="toolbar">
      <div class="search-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" stroke-linecap="round" />
        </svg>
        <input id="dir-search" type="search" placeholder="Search resources…" value="${esc(state.directory.q)}" aria-label="Search resources" />
      </div>
      <div class="filters" id="dir-filters"></div>
    </div>

    <div class="result-count" id="dir-count">Loading…</div>
    <div id="dir-results"><div class="spinner"></div></div>
  `;

  renderFilters();
  const search = document.getElementById('dir-search');
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.directory.q = search.value.trim();
      syncDirectoryQuery();
      loadDirectory();
    }, 220);
  });

  await loadDirectory();
}

function renderFilters() {
  const holder = document.getElementById('dir-filters');
  if (!holder) return;
  const options = ['', ...state.categories];
  holder.innerHTML = options
    .map(
      (c) =>
        `<button class="filter ${state.directory.category === c ? 'active' : ''}" data-category="${esc(
          c
        )}" type="button">${esc(c || 'All')}</button>`
    )
    .join('');
  holder.querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.directory.category = button.dataset.category || '';
      renderFilters();
      syncDirectoryQuery();
      loadDirectory();
    });
  });
}

function syncDirectoryQuery() {
  const params = new URLSearchParams();
  if (state.directory.q) params.set('q', state.directory.q);
  if (state.directory.category) params.set('category', state.directory.category);
  const suffix = params.toString() ? `?${params}` : '';
  history.replaceState({}, '', `/directory${suffix}`);
}

async function loadDirectory() {
  const results = document.getElementById('dir-results');
  const count = document.getElementById('dir-count');
  if (!results) return;
  const params = new URLSearchParams();
  if (state.directory.q) params.set('q', state.directory.q);
  if (state.directory.category) params.set('category', state.directory.category);

  try {
    const data = await api(`/api/directory${params.toString() ? `?${params}` : ''}`);
    state.directory.resources = data.resources;
    if (data.categories && data.categories.length) state.categories = data.categories;

    if (count) {
      const total = data.resources.length;
      count.textContent = `${total} resource${total === 1 ? '' : 's'}${
        state.directory.q || state.directory.category ? ' matching your filters' : ''
      }`;
    }

    if (!data.resources.length) {
      results.innerHTML = `
        <div class="empty">
          <strong>No resources found</strong>
          <p>${
            state.directory.q || state.directory.category
              ? 'Try a different search term or clear the category filter.'
              : 'An administrator has not added any resources yet.'
          }</p>
        </div>`;
      return;
    }

    results.innerHTML = `<div class="resource-grid">${data.resources
      .map(
        (r) => `
        <article class="resource-card">
          <div class="resource-top">
            <div class="resource-icon ${r.icon ? '' : 'letter'}">${esc(r.icon || r.name.slice(0, 1))}</div>
            <div>
              <h3>${esc(r.name)}</h3>
              <span class="resource-cat">${esc(r.category)}</span>
            </div>
          </div>
          <p class="resource-desc">${esc(r.description)}</p>
          <div class="resource-foot">
            <span class="resource-date">Added ${formatDate(r.createdAt)}</span>
            <a class="resource-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">
              Visit
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </a>
          </div>
        </article>`
      )
      .join('')}</div>`;
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      syncChrome();
      navigate('/login', { replace: true });
      return;
    }
    if (error.status === 403) {
      // Reflect the freshly observed status, then show the appropriate gate.
      try {
        const me = await api('/api/auth/me');
        state.user = me.user;
      } catch { /* ignore */ }
      syncChrome();
      if (state.user) {
        if (state.user.role === 'admin' || state.user.status === 'approved') {
          render();
        } else {
          viewBlocked(state.user);
        }
      }
      return;
    }
    results.innerHTML = `<div class="empty"><strong>Could not load resources</strong><p>${esc(
      error.message
    )}</p></div>`;
  }
}

/* ---------------------------------------------------------------- admin */

async function viewAdmin() {
  const user = state.user;
  if (!user || user.role !== 'admin') {
    viewBlocked(user || { status: 'pending' });
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Admin dashboard</h1>
        <p>Live member approvals, account management and the resource catalogue.</p>
      </div>
      <span class="badge admin">administrator</span>
    </div>

    <div class="stat-grid" id="admin-stats">
      ${statSkeleton(['Total members', 'Pending', 'Approved', 'Suspended', 'Resources'])}
    </div>

    <div class="tabs" id="admin-tabs">
      <button class="tab ${state.admin.tab === 'approvals' ? 'active' : ''}" data-tab="approvals" type="button">Approvals</button>
      <button class="tab ${state.admin.tab === 'members' ? 'active' : ''}" data-tab="members" type="button">Members</button>
      <button class="tab ${state.admin.tab === 'resources' ? 'active' : ''}" data-tab="resources" type="button">Resources</button>
    </div>

    <div id="admin-panel"></div>
  `;

  document.getElementById('admin-tabs').querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.admin.tab = button.dataset.tab;
      document.querySelectorAll('#admin-tabs .tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === state.admin.tab);
      });
      renderAdminPanel();
    });
  });

  await Promise.all([loadAdminStats(), loadAdminMembers(), loadAdminResources()]);
  renderAdminPanel();
}

function statSkeleton(labels) {
  return labels
    .map(
      (label) =>
        `<div class="stat-card"><div class="label">${esc(label)}</div><div class="value">—</div></div>`
    )
    .join('');
}

async function loadAdminStats() {
  try {
    const data = await api('/api/admin/stats');
    const holder = document.getElementById('admin-stats');
    if (!holder) return;
    const s = data.stats;
    holder.innerHTML = [
      ['Total members', s.totalMembers, ''],
      ['Pending', s.pendingMembers, 'pending'],
      ['Approved', s.approvedMembers, 'approved'],
      ['Suspended', s.suspendedMembers, 'suspended'],
      ['Total resources', s.totalResources, ''],
    ]
      .map(
        ([label, value, cls]) =>
          `<div class="stat-card ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(
            value
          )}</div></div>`
      )
      .join('');
  } catch (error) {
    if (error.status === 403 || error.status === 401) {
      toast('Administrator access required.', 'error');
      navigate('/');
    }
  }
}

async function loadAdminMembers() {
  const params = new URLSearchParams();
  if (state.admin.status && state.admin.status !== 'all') params.set('status', state.admin.status);
  if (state.admin.q) params.set('q', state.admin.q);
  try {
    const data = await api(`/api/admin/members${params.toString() ? `?${params}` : ''}`);
    state.admin.members = data.members;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadAdminResources() {
  try {
    const data = await api('/api/admin/resources');
    state.admin.resources = data.resources;
    if (data.categories && data.categories.length) state.categories = data.categories;
  } catch (error) {
    toast(error.message, 'error');
  }
}

function memberRow(m, adminId) {
  const isSelf = m.id === adminId;
  const isAdminRow = m.role === 'admin';
  const actions = [];
  if (!isAdminRow) {
    if (m.status !== 'approved') {
      actions.push(`<button class="btn btn-success btn-sm" data-act="approve" data-id="${m.id}" type="button">Approve</button>`);
    }
    if (m.status !== 'suspended') {
      actions.push(`<button class="btn btn-danger btn-sm" data-act="suspend" data-id="${m.id}" type="button">Suspend</button>`);
    }
    if (m.status !== 'rejected') {
      actions.push(`<button class="btn btn-ghost btn-sm" data-act="reject" data-id="${m.id}" type="button">Reject</button>`);
    }
    if (m.status !== 'pending') {
      actions.push(`<button class="btn btn-ghost btn-sm" data-act="pending" data-id="${m.id}" type="button">Reset to pending</button>`);
    }
  }
  return `
    <div class="member-row">
      <div class="member-ident">
        <span class="avatar-lg">${esc(initials(m.name))}</span>
        <div>
          <div class="member-name">${esc(m.name)}${isSelf ? ' · you' : ''}</div>
          <div class="member-email">${esc(m.email)}</div>
        </div>
      </div>
      <div class="member-meta">
        <span class="badge ${esc(m.status)}">${esc(m.status)}</span>
        ${isAdminRow ? '<span class="badge admin">admin</span>' : ''}
        <span class="inline-note">Joined ${formatDate(m.createdAt)}</span>
      </div>
      <div class="member-actions">${actions.join('')}</div>
    </div>
  `;
}

function resourceAdminRow(r) {
  return `
    <div class="resource-admin-row">
      <div class="resource-icon ${r.icon ? '' : 'letter'}">${esc(r.icon || r.name.slice(0, 1))}</div>
      <div class="info">
        <div class="name">${esc(r.name)} <span class="inline-note">· ${esc(r.category)}</span></div>
        <div class="url">${esc(r.url)}</div>
      </div>
      <div class="member-actions">
        <button class="btn btn-ghost btn-sm" data-res-edit="${r.id}" type="button">Edit</button>
        <button class="btn btn-danger btn-sm" data-res-delete="${r.id}" type="button">Delete</button>
      </div>
    </div>
  `;
}

function renderAdminPanel() {
  const panel = document.getElementById('admin-panel');
  if (!panel) return;
  const adminId = state.user ? state.user.id : null;

  if (state.admin.tab === 'approvals') {
    const pending = state.admin.members.filter((m) => m.status === 'pending' && m.role !== 'admin');
    panel.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h2>Pending approvals</h2>
          <span class="badge pending">${pending.length}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" id="reload-members" type="button">Reload</button>
        </div>
        <div class="panel-body">
          ${
            pending.length
              ? `<div class="member-list">${pending.map((m) => memberRow(m, adminId)).join('')}</div>`
              : `<div class="empty"><strong>No pending registrations</strong><p>New sign-ups appear here for review.</p></div>`
          }
        </div>
      </div>`;
    wireMemberActions();
    const reload = document.getElementById('reload-members');
    if (reload) {
      reload.addEventListener('click', async () => {
        await Promise.all([loadAdminStats(), loadAdminMembers()]);
        renderAdminPanel();
      });
    }
    return;
  }

  if (state.admin.tab === 'members') {
    const filters = ['all', 'pending', 'approved', 'suspended', 'rejected'];
    panel.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h2>All members</h2>
          <span class="spacer"></span>
          <div class="search-field" style="flex:0 1 240px">
            <input id="member-search" type="search" placeholder="Search name or email…" value="${esc(
              state.admin.q
            )}" aria-label="Search members" />
          </div>
        </div>
        <div class="panel-head" style="border-bottom:1px solid var(--line);padding-top:10px;padding-bottom:10px">
          <div class="filters">
            ${filters
              .map(
                (f) =>
                  `<button class="filter ${state.admin.status === f ? 'active' : ''}" data-status="${f}" type="button">${esc(
                    f === 'all' ? 'All' : f
                  )}</button>`
              )
              .join('')}
          </div>
        </div>
        <div class="panel-body">
          ${
            state.admin.members.length
              ? `<div class="member-list">${state.admin.members.map((m) => memberRow(m, adminId)).join('')}</div>`
              : `<div class="empty"><strong>No members match</strong><p>Adjust the filter or search term.</p></div>`
          }
        </div>
      </div>`;

    const search = document.getElementById('member-search');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        state.admin.q = search.value.trim();
        await loadAdminMembers();
        renderAdminPanel();
      }, 220);
    });

    panel.querySelectorAll('[data-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        state.admin.status = button.dataset.status;
        await loadAdminMembers();
        renderAdminPanel();
      });
    });

    wireMemberActions();
    return;
  }

  // resources
  const editing = state.admin.editingId
    ? state.admin.resources.find((r) => r.id === state.admin.editingId)
    : null;

  panel.innerHTML = `
    <div class="panel" style="margin-bottom:18px">
      <div class="form-panel">
        <h2>${editing ? `Edit “${esc(editing.name)}”` : 'Add a resource'}</h2>
        <div id="resource-error" hidden></div>
        <form id="resource-form">
          <div class="form-row">
            <div class="field">
              <label for="res-name">Resource name</label>
              <input id="res-name" name="name" required value="${esc(editing ? editing.name : '')}" placeholder="MDN Web Docs" />
            </div>
            <div class="field">
              <label for="res-category">Category</label>
              <select id="res-category" name="category">
                ${state.categories
                  .map(
                    (c) =>
                      `<option value="${esc(c)}" ${
                        editing && editing.category === c ? 'selected' : ''
                      }>${esc(c)}</option>`
                  )
                  .join('')}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="res-url">Website URL</label>
            <input id="res-url" name="url" required value="${esc(editing ? editing.url : '')}" placeholder="https://example.com" />
          </div>
          <div class="field">
            <label for="res-desc">Description</label>
            <textarea id="res-desc" name="description" required placeholder="What makes this resource worth bookmarking?">${esc(
              editing ? editing.description : ''
            )}</textarea>
          </div>
          <div class="field" style="max-width:150px">
            <label for="res-icon">Icon (optional emoji)</label>
            <input id="res-icon" name="icon" maxlength="4" value="${esc(editing ? editing.icon || '' : '')}" placeholder="📘" />
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit" id="res-submit">${editing ? 'Save changes' : 'Add resource'}</button>
            ${
              editing
                ? `<button class="btn btn-ghost" type="button" id="res-cancel">Cancel</button>`
                : ''
            }
            <span class="inline-note">Saved directly to the database.</span>
          </div>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Resources</h2>
        <span class="badge">${state.admin.resources.length}</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="reload-resources" type="button">Reload</button>
      </div>
      <div class="panel-body">
        ${
          state.admin.resources.length
            ? state.admin.resources.map(resourceAdminRow).join('')
            : `<div class="empty"><strong>No resources yet</strong><p>Add the first one above.</p></div>`
        }
      </div>
    </div>
  `;

  const form = document.getElementById('resource-form');
  const errorBox = document.getElementById('resource-error');
  const submit = document.getElementById('res-submit');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = editing ? 'Saving…' : 'Adding…';
    const payload = {
      name: form.name.value,
      description: form.description.value,
      url: form.url.value,
      category: form.category.value,
      icon: form.icon.value,
    };
    try {
      if (editing) {
        await api(`/api/admin/resources/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        toast('Resource updated.');
      } else {
        await api('/api/admin/resources', { method: 'POST', body: JSON.stringify(payload) });
        toast('Resource added.');
      }
      state.admin.editingId = null;
      await Promise.all([loadAdminResources(), loadAdminStats()]);
      renderAdminPanel();
    } catch (error) {
      errorBox.hidden = false;
      errorBox.className = 'alert';
      errorBox.textContent = error.message;
      submit.disabled = false;
      submit.textContent = editing ? 'Save changes' : 'Add resource';
    }
  });

  const cancel = document.getElementById('res-cancel');
  if (cancel) {
    cancel.addEventListener('click', () => {
      state.admin.editingId = null;
      renderAdminPanel();
    });
  }

  document.querySelectorAll('[data-res-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      state.admin.editingId = Number(button.dataset.resEdit);
      renderAdminPanel();
      const nameInput = document.getElementById('res-name');
      if (nameInput) nameInput.focus();
    });
  });

  document.querySelectorAll('[data-res-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.resDelete);
      const resource = state.admin.resources.find((r) => r.id === id);
      if (!confirm(`Delete “${resource ? resource.name : 'this resource'}”? This cannot be undone.`)) {
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/admin/resources/${id}`, { method: 'DELETE' });
        toast('Resource deleted.');
        if (state.admin.editingId === id) state.admin.editingId = null;
        await Promise.all([loadAdminResources(), loadAdminStats()]);
        renderAdminPanel();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  });

  const reload = document.getElementById('reload-resources');
  if (reload) {
    reload.addEventListener('click', async () => {
      await loadAdminResources();
      renderAdminPanel();
    });
  }
}

function wireMemberActions() {
  document.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.id);
      const action = button.dataset.act;
      const statusMap = { approve: 'approved', suspend: 'suspended', reject: 'rejected', pending: 'pending' };
      button.disabled = true;
      try {
        await api(`/api/admin/members/${id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: statusMap[action] }),
        });
        toast(`Member ${statusMap[action]}.`);
        await Promise.all([loadAdminStats(), loadAdminMembers()]);
        renderAdminPanel();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

/* ---------------------------------------------------------------- account */

function viewAccount() {
  const user = state.user;
  if (!user) {
    navigate('/login', { replace: true });
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Account settings</h1>
        <p>Manage your profile and credentials.</p>
      </div>
      <span class="badge ${esc(user.status)}">${esc(user.role === 'admin' ? 'administrator' : user.status)}</span>
    </div>

    <div class="account-grid">
      <div class="panel">
        <div class="form-panel">
          <h2>Profile</h2>
          <div id="profile-error" hidden></div>
          <form id="profile-form">
            <div class="field">
              <label for="acc-name">Full name</label>
              <input id="acc-name" name="name" value="${esc(user.name)}" required />
            </div>
            <div class="field">
              <label for="acc-email">Email</label>
              <input id="acc-email" value="${esc(user.email)}" disabled />
              <span class="hint">Email changes are handled by the administrator.</span>
            </div>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit" id="profile-submit">Save profile</button>
            </div>
          </form>
        </div>
      </div>

      <div>
        <div class="panel" style="margin-bottom:18px">
          <div class="form-panel">
            <h2>Change password</h2>
            <div id="password-error" hidden></div>
            <form id="password-form">
              <div class="field">
                <label for="cur-password">Current password</label>
                <input id="cur-password" name="currentPassword" type="password" autocomplete="current-password" required />
              </div>
              <div class="field">
                <label for="new-password">New password</label>
                <input id="new-password" name="newPassword" type="password" autocomplete="new-password" required />
                <span class="hint">Minimum 8 characters.</span>
              </div>
              <div class="form-actions">
                <button class="btn btn-primary" type="submit" id="password-submit">Update password</button>
              </div>
            </form>
          </div>
        </div>

        <div class="panel">
          <div class="form-panel">
            <h2>Membership</h2>
            <div class="info-list">
              <div class="meta-row"><span>Status</span><span class="badge ${esc(user.status)}">${esc(user.status)}</span></div>
              <div class="meta-row"><span>Role</span><span>${esc(user.role)}</span></div>
              <div class="meta-row"><span>Registered</span><span>${formatDate(user.createdAt)}</span></div>
              <div class="meta-row"><span>Approved</span><span>${formatDate(user.approvedAt)}</span></div>
              <div class="meta-row"><span>Last sign-in</span><span>${formatDate(user.lastLoginAt)}</span></div>
            </div>
            <p class="inline-note" style="margin-top:16px">
              Directory access requires administrator approval. No email confirmation is used anywhere in this flow.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;

  const profileForm = document.getElementById('profile-form');
  const profileError = document.getElementById('profile-error');
  const profileSubmit = document.getElementById('profile-submit');

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    profileError.hidden = true;
    profileSubmit.disabled = true;
    try {
      const data = await api('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({ name: profileForm.name.value }),
      });
      state.user = data.user;
      syncChrome();
      toast('Profile updated.');
      render();
    } catch (error) {
      profileError.hidden = false;
      profileError.className = 'alert';
      profileError.textContent = error.message;
      profileSubmit.disabled = false;
    }
  });

  const passwordForm = document.getElementById('password-form');
  const passwordError = document.getElementById('password-error');
  const passwordSubmit = document.getElementById('password-submit');

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    passwordError.hidden = true;
    passwordSubmit.disabled = true;
    try {
      await api('/api/account/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword.value,
          newPassword: passwordForm.newPassword.value,
        }),
      });
      passwordForm.reset();
      toast('Password updated.');
    } catch (error) {
      passwordError.hidden = false;
      passwordError.className = 'alert';
      passwordError.textContent = error.message;
    } finally {
      passwordSubmit.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Render cycle
 * ------------------------------------------------------------------ */

function render() {
  if (!state.booted) return;
  const path = currentPath();
  syncChrome();

  if (!ROUTES.includes(path)) {
    view.innerHTML = `
      <div class="status-screen">
        <div class="status-icon">🧭</div>
        <h1>Page not found</h1>
        <p>That route does not exist in NEXUS HUB.</p>
        <div class="hero-actions" style="justify-content:center">
          <a class="btn btn-primary" href="/" data-link>Back to home</a>
        </div>
      </div>`;
    return;
  }

  const user = state.user;
  const requiresAuth = ['/directory', '/admin', '/account', '/pending'].includes(path);
  if (requiresAuth && !user) {
    navigate('/login', { replace: true });
    return;
  }

  if (path === '/' && user) {
    // Signed-in members still get the marketing page as a landing surface.
  }

  switch (path) {
    case '/':
      viewLanding();
      break;
    case '/login':
      viewLogin();
      break;
    case '/register':
      viewRegister();
      break;
    case '/pending':
      viewPending();
      break;
    case '/directory':
      if (!isPrivileged(user)) return viewBlocked(user);
      viewDirectory();
      break;
    case '/admin':
      if (user.role !== 'admin') return viewBlocked(user);
      viewAdmin();
      break;
    case '/account':
      viewAccount();
      break;
    default:
      break;
  }

  const nav = document.getElementById('nav');
  if (nav) nav.classList.remove('open');
  const toggle = document.getElementById('menu-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

/* ------------------------------------------------------------------ *
 * Global listeners + boot
 * ------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (link) {
    const href = link.getAttribute('href');
    if (href && href.startsWith('/')) {
      event.preventDefault();
      if (currentPath() !== href) navigate(href);
    }
  }
});

window.addEventListener('popstate', () => render());

const menuToggle = document.getElementById('menu-toggle');
if (menuToggle) {
  menuToggle.addEventListener('click', () => {
    const nav = document.getElementById('nav');
    const open = nav.classList.toggle('open');
    menuToggle.setAttribute('aria-expanded', String(open));
  });
}

async function boot() {
  spinner();
  const params = new URLSearchParams(location.search);
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  state.directory.q = q;
  state.directory.category = category;

  try {
    const [me, cats] = await Promise.all([
      api('/api/auth/me').catch(() => ({ user: null })),
      api('/api/categories').catch(() => ({ categories: CATEGORY_FALLBACK })),
    ]);
    state.user = me.user;
    if (cats.categories && cats.categories.length) state.categories = cats.categories;
  } catch {
    state.user = null;
  }
  state.booted = true;
  render();
}

boot();
