const state = {
  period: 'week',
  sport: 'all',
  members: [],
  leaderboard: null,
  isAdmin: false
};

const fmtKm = (n) => `${n.toLocaleString('fr-FR')} km`;
const fmtM = (n) => `${n.toLocaleString('fr-FR')} m`;
const fmtH = (n) => `${n.toLocaleString('fr-FR')} h`;
const fmtKmh = (n) => `${n.toLocaleString('fr-FR')} km/h`;

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401 || res.status === 403) {
    const err = new Error('unauthorized');
    err.status = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(`Requête échouée: ${url}`);
  return res.json();
}

// --- Access gate ---

function showApp() {
  document.getElementById('lock-screen').hidden = true;
  document.getElementById('main-header').hidden = false;
  document.getElementById('main-content').hidden = false;
  document.getElementById('main-footer').hidden = false;
}

function showLock() {
  document.getElementById('lock-screen').hidden = false;
  document.getElementById('main-header').hidden = true;
  document.getElementById('main-content').hidden = true;
  document.getElementById('main-footer').hidden = true;
}

document.getElementById('access-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('access-code').value;
  const errorEl = document.getElementById('access-error');
  try {
    await fetchJSON('/api/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    errorEl.hidden = true;
    showApp();
    boot();
  } catch (err) {
    errorEl.hidden = false;
  }
});

// --- Admin mode ---

function renderAdminUI() {
  document.getElementById('admin-login').hidden = state.isAdmin;
  document.getElementById('admin-active').hidden = !state.isAdmin;
  document.getElementById('pending-section').hidden = !state.isAdmin;
}

document.getElementById('admin-login-btn').addEventListener('click', () => {
  document.getElementById('admin-login').hidden = true;
  document.getElementById('admin-form').hidden = false;
});
document.getElementById('admin-cancel-btn').addEventListener('click', () => {
  document.getElementById('admin-form').hidden = true;
  document.getElementById('admin-login').hidden = false;
});
document.getElementById('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('admin-code').value;
  try {
    await fetchJSON('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    state.isAdmin = true;
    document.getElementById('admin-form').hidden = true;
    document.getElementById('admin-code').value = '';
    renderAdminUI();
    await loadPending();
    renderRoster();
  } catch (err) {
    alert('Code admin incorrect.');
  }
});
document.getElementById('admin-logout-btn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  state.isAdmin = false;
  renderAdminUI();
  renderRoster();
});

// --- Pending approval requests (admin only) ---

async function loadPending() {
  if (!state.isAdmin) return;
  try {
    const pending = await fetchJSON('/api/members/pending');
    renderPending(pending);
  } catch (err) {
    console.error(err);
  }
}

function renderPending(pending) {
  const list = document.getElementById('pending-list');
  if (!pending.length) {
    list.innerHTML = `<p style="color:var(--text-ink-dim); font-size:0.9rem;">Aucune demande en attente.</p>`;
    return;
  }
  list.innerHTML = pending.map((p) => `
    <div class="pending-row">
      ${p.avatar_url ? `<img src="${p.avatar_url}" alt="">` : '<span class="avatar-placeholder"></span>'}
      <span class="pending-name">${escapeHtml(p.display_name)}</span>
      <button class="btn-approve" data-id="${p.id}">Accepter</button>
      <button class="btn-reject" data-id="${p.id}">Refuser</button>
    </div>
  `).join('');

  list.querySelectorAll('.btn-approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/members/${btn.dataset.id}/approve`, { method: 'POST' });
      await loadPending();
      await loadMembers();
      await loadLeaderboard();
    });
  });
  list.querySelectorAll('.btn-reject').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/members/${btn.dataset.id}`, { method: 'DELETE' });
      await loadPending();
    });
  });
}

// --- Data loading ---

async function loadMembers() {
  state.members = await fetchJSON('/api/members');
  renderRoster();
}

async function loadLeaderboard() {
  const data = await fetchJSON(`/api/leaderboard?period=${state.period}&sport=${state.sport}`);
  state.leaderboard = data;
  renderSportFilter(data.availableSports);
  renderEmptyState();
  renderSkyline(data.members);
  renderPodiums(data.members);
  renderLedger(data.members);
}

function renderEmptyState() {
  const hasMembers = state.members.length > 0;
  document.getElementById('empty-state').hidden = hasMembers;
  document.getElementById('podiums').hidden = !hasMembers;
  const ledgerSection = document.querySelector('.ledger');
  if (ledgerSection) ledgerSection.hidden = !hasMembers;
  const skylineSection = document.querySelector('.skyline-section');
  if (skylineSection) skylineSection.hidden = !hasMembers;
}

// --- Signature element: mountain skyline from cumulative elevation gain ---
function renderSkyline(members) {
  const svg = document.getElementById('skyline');
  const labelsEl = document.getElementById('skyline-labels');
  svg.innerHTML = '';
  labelsEl.innerHTML = '';
  if (!members.length) return;

  const sorted = [...members].sort((a, b) => b.elevationM - a.elevationM);
  const maxElev = Math.max(...sorted.map((m) => m.elevationM), 1);
  const width = 1000;
  const height = 260;
  const baseline = 230;
  const peakTop = 40;
  const n = sorted.length;
  const slotWidth = width / n;

  const colors = ['#d4a94a', '#c2622d', '#6f8f6a', '#7a94a8', '#9c7a5c', '#8a6f9c'];

  sorted.forEach((m, i) => {
    const ratio = m.elevationM / maxElev;
    const peakHeight = peakTop + (1 - ratio) * (baseline - peakTop);
    const cx = slotWidth * i + slotWidth / 2;
    const leftBase = slotWidth * i - slotWidth * 0.15;
    const rightBase = slotWidth * (i + 1) + slotWidth * 0.15;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${leftBase} ${baseline} L ${cx} ${peakHeight} L ${rightBase} ${baseline} Z`;
    path.setAttribute('d', d);
    path.setAttribute('fill', colors[i % colors.length]);
    path.setAttribute('fill-opacity', i === 0 ? '0.95' : '0.55');
    path.setAttribute('stroke', 'rgba(22,35,42,0.4)');
    path.setAttribute('stroke-width', '1');
    svg.appendChild(path);

    const label = document.createElement('div');
    label.className = 'peak-label';
    label.innerHTML = `<b>${escapeHtml(m.name)}</b>${m.elevationM.toLocaleString('fr-FR')} m D+`;
    labelsEl.appendChild(label);
  });

  const baselineLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baselineLine.setAttribute('x1', '0');
  baselineLine.setAttribute('x2', String(width));
  baselineLine.setAttribute('y1', String(baseline));
  baselineLine.setAttribute('y2', String(baseline));
  baselineLine.setAttribute('stroke', 'rgba(239,231,216,0.25)');
  baselineLine.setAttribute('stroke-width', '1');
  svg.insertBefore(baselineLine, svg.firstChild);
}

function podiumBlock(title, unit, members, key, formatter) {
  const sorted = [...members].filter((m) => m[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 5);
  const rows = sorted.length
    ? sorted.map((m, i) => `
        <div class="podium-row rank-${i + 1}">
          <span class="podium-rank">${i + 1}</span>
          <span class="podium-name">${escapeHtml(m.name)}</span>
          <span class="podium-value">${formatter(m[key])}</span>
        </div>`).join('')
    : `<p style="color:var(--text-paper-dim); font-size:0.85rem;">Aucune donnée sur cette période.</p>`;
  return `<div class="podium-card"><h3>${title}</h3>${rows}</div>`;
}

function renderPodiums(members) {
  const el = document.getElementById('podiums');
  el.innerHTML = [
    podiumBlock('Distance', 'km', members, 'distanceKm', fmtKm),
    podiumBlock('Dénivelé cumulé', 'm', members, 'elevationM', fmtM),
    podiumBlock('Nombre de sorties', '', members, 'activityCount', (n) => `${n}`),
    podiumBlock('Vitesse moyenne', 'km/h', members, 'avgSpeedKmh', fmtKmh)
  ].join('');
}

function renderLedger(members) {
  const body = document.getElementById('ledger-body');
  const sorted = [...members].sort((a, b) => b.distanceKm - a.distanceKm);
  body.innerHTML = sorted.map((m) => `
    <tr>
      <td>${escapeHtml(m.name)}</td>
      <td>${m.activityCount}</td>
      <td>${fmtKm(m.distanceKm)}</td>
      <td>${fmtM(m.elevationM)}</td>
      <td>${fmtH(m.timeHours)}</td>
      <td>${fmtKmh(m.avgSpeedKmh)}</td>
    </tr>
  `).join('');
}

function renderSportFilter(availableSports) {
  const container = document.getElementById('sport-filter');
  const existingValues = [...container.querySelectorAll('button')].map((b) => b.dataset.value);
  const wanted = ['all', ...availableSports];
  if (existingValues.join(',') === wanted.join(',')) {
    [...container.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b.dataset.value === state.sport));
    return;
  }
  container.innerHTML = wanted.map((s) => `<button data-value="${s}" class="${s === state.sport ? 'active' : ''}">${s === 'all' ? 'Toutes' : escapeHtml(s)}</button>`).join('');
  container.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sport = btn.dataset.value;
      container.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadLeaderboard();
    });
  });
}

function renderRoster() {
  const list = document.getElementById('member-list');
  if (!state.members.length) {
    list.innerHTML = `<p style="color:var(--text-ink-dim); font-size:0.9rem;">Aucun membre approuvé pour l'instant.</p>`;
    return;
  }
  list.innerHTML = state.members.map((m) => `
    <span class="member-chip">
      ${m.avatar_url ? `<img src="${m.avatar_url}" alt="">` : ''}
      ${escapeHtml(m.display_name)}
      ${state.isAdmin ? `<button data-id="${m.id}" title="Retirer">✕</button>` : ''}
    </span>
  `).join('');
  if (state.isAdmin) {
    list.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Retirer ${btn.parentElement.textContent.trim().replace('✕', '')} et supprimer ses données ?`)) return;
        await fetch(`/api/members/${btn.dataset.id}`, { method: 'DELETE' });
        await loadMembers();
        await loadLeaderboard();
      });
    });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Controls ---
document.getElementById('period-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.period = btn.dataset.value;
  document.querySelectorAll('#period-filter button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  loadLeaderboard();
});

document.getElementById('sync-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-btn');
  const icon = btn.querySelector('.sync-icon');
  btn.disabled = true;
  icon.classList.add('spinning');
  try {
    await fetchJSON('/api/sync', { method: 'POST' });
    await loadLeaderboard();
  } catch (err) {
    alert('La synchronisation a échoué : ' + err.message);
  } finally {
    btn.disabled = false;
    icon.classList.remove('spinning');
  }
});

document.getElementById('connect-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('connect-name').value.trim();
  if (!name) return;
  window.location.href = `/api/auth/strava/connect?name=${encodeURIComponent(name)}`;
});

// --- Connection feedback banner from OAuth redirect ---
function showConnectFeedback() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('connect');
  if (!status) return;
  const messages = {
    success: 'Compte Strava reconnecté avec succès.',
    pending: "Demande envoyée ! Un administrateur doit valider l'accès avant que les stats apparaissent.",
    denied: "La connexion a été annulée : l'autorisation Strava n'a pas été accordée.",
    error: 'Une erreur est survenue pendant la connexion à Strava. Réessaie.'
  };
  if (messages[status]) {
    setTimeout(() => alert(messages[status]), 200);
  }
  window.history.replaceState({}, '', window.location.pathname);
}

// --- Boot sequence ---

async function boot() {
  try {
    const session = await fetchJSON('/api/session');
    state.isAdmin = session.admin;
    renderAdminUI();
    await loadMembers();
    await loadLeaderboard();
    if (state.isAdmin) await loadPending();
    showConnectFeedback();
  } catch (err) {
    console.error(err);
  }
}

(async function init() {
  try {
    const session = await fetchJSON('/api/session');
    if (session.access) {
      showApp();
      await boot();
    } else {
      showLock();
    }
  } catch (err) {
    showLock();
  }
})();
