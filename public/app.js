const state = {
  period: 'week',
  sport: 'all',
  members: [],
  leaderboard: null,
  isAdmin: false
};

// Stable color per member (same member = same color everywhere on the site,
// regardless of current sort order), cycling through this palette by id.
const MEMBER_COLORS = ['#d4a94a', '#c2622d', '#6f8f6a', '#7a94a8', '#9c7a5c', '#8a6f9c', '#e2793b', '#4a90a4'];
function colorForMember(id) {
  return MEMBER_COLORS[Number(id) % MEMBER_COLORS.length];
}

// Decodes a Google/Strava-encoded polyline string into [lat, lng] pairs.
// Standard algorithm, precision 1e5 (same as Strava's summary_polyline).
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let result = 1, shift = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat * 1e-5, lng * 1e-5]);
  }
  return points;
}

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

// --- Bike best-efforts comparative table ---

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadBikeTable() {
  try {
    const data = await fetchJSON('/api/bike-best-efforts');
    renderBikeTable(data.targets, data.members);
  } catch (err) {
    console.error(err);
  }
}

function renderBikeTable(targets, members) {
  const section = document.querySelector('.bike-section');
  const hasAnyEffort = members.some((m) => Object.keys(m.efforts).length > 0 || m.longestRide);

  if (!members.length || !hasAnyEffort) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const head = document.getElementById('bike-table-head');
  head.innerHTML = `<th>Distance</th>${members.map((m) => `<th>${escapeHtml(m.name)}</th>`).join('')}`;

  const body = document.getElementById('bike-table-body');
  let rowsHtml = '';

  // Longest single ride — its own row, distance-based rather than time-based.
  let bestLongestIdx = -1, bestLongestKm = -Infinity;
  members.forEach((m, idx) => {
    if (m.longestRide && m.longestRide.distanceKm > bestLongestKm) {
      bestLongestKm = m.longestRide.distanceKm;
      bestLongestIdx = idx;
    }
  });
  const longestCells = members.map((m, idx) => {
    if (!m.longestRide) return `<td class="bike-cell-empty">—</td>`;
    const isBest = idx === bestLongestIdx;
    return `<td class="${isBest ? 'bike-cell-best' : ''}">
      ${isBest ? '<span class="bike-medal" title="Record familial">🏆</span>' : ''}
      <span class="bike-cell-time">${m.longestRide.distanceKm} km</span>
      <span class="bike-cell-sub">${formatShortDate(m.longestRide.achievedAt)}</span>
    </td>`;
  }).join('');
  rowsHtml += `<tr class="bike-row-longest"><td>Sortie la plus longue</td>${longestCells}</tr>`;

  // One row per reference distance, fastest member in the family highlighted.
  rowsHtml += targets.map((target) => {
    let bestIdx = -1, bestTimeS = Infinity;
    members.forEach((m, idx) => {
      const e = m.efforts[target.label];
      if (e && e.timeS < bestTimeS) { bestTimeS = e.timeS; bestIdx = idx; }
    });
    const cells = members.map((m, idx) => {
      const effort = m.efforts[target.label];
      if (!effort) return `<td class="bike-cell-empty">—</td>`;
      const isBest = idx === bestIdx;
      return `<td class="${isBest ? 'bike-cell-best' : ''}">
        ${isBest ? '<span class="bike-medal" title="Record familial">🏆</span>' : ''}
        <span class="bike-cell-time">${formatDuration(effort.timeS)}</span>
        <span class="bike-cell-sub">${effort.avgSpeedKmh} km/h</span>
        <span class="bike-cell-sub">${formatShortDate(effort.achievedAt)}</span>
      </td>`;
    }).join('');
    return `<tr><td>${escapeHtml(target.label)}</td>${cells}</tr>`;
  }).join('');

  body.innerHTML = rowsHtml;
}

// --- Route map ---
let leafletMap = null;
let routeLayerGroup = null;

function ensureMap() {
  if (leafletMap) return;
  leafletMap = L.map('routes-map', { scrollWheelZoom: false }).setView([46.6, 2.4], 5); // default: France
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19
  }).addTo(leafletMap);
  routeLayerGroup = L.layerGroup().addTo(leafletMap);
}

async function loadRoutes() {
  try {
    const data = await fetchJSON(`/api/routes?period=${state.period}&sport=${state.sport}`);
    renderRoutes(data.members);
  } catch (err) {
    console.error(err);
  }
}

function renderRoutes(members) {
  const section = document.querySelector('.map-section');
  const legend = document.getElementById('map-legend');

  if (!members.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  ensureMap();
  // Leaflet needs a nudge to recalc size the first time its container becomes visible
  setTimeout(() => leafletMap.invalidateSize(), 0);

  routeLayerGroup.clearLayers();
  const bounds = [];

  members.forEach((m) => {
    const color = colorForMember(m.id);
    m.polylines.forEach((encoded) => {
      const points = decodePolyline(encoded);
      if (points.length < 2) return;
      L.polyline(points, { color, weight: 2.5, opacity: 0.75 }).addTo(routeLayerGroup);
      bounds.push(...points);
    });
  });

  if (bounds.length) {
    leafletMap.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
  }

  legend.innerHTML = members.map((m) => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${colorForMember(m.id)}"></span>
      ${escapeHtml(m.name)}
    </span>
  `).join('');
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

  const colors = MEMBER_COLORS;

  sorted.forEach((m, i) => {
    const ratio = m.elevationM / maxElev;
    const peakHeight = peakTop + (1 - ratio) * (baseline - peakTop);
    const cx = slotWidth * i + slotWidth / 2;
    const leftBase = slotWidth * i - slotWidth * 0.15;
    const rightBase = slotWidth * (i + 1) + slotWidth * 0.15;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${leftBase} ${baseline} L ${cx} ${peakHeight} L ${rightBase} ${baseline} Z`;
    path.setAttribute('d', d);
    path.setAttribute('fill', colorForMember(m.id));
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
      loadRoutes();
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
  loadRoutes();
});

document.getElementById('sync-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-btn');
  const icon = btn.querySelector('.sync-icon');
  btn.disabled = true;
  icon.classList.add('spinning');
  try {
    await fetchJSON('/api/sync', { method: 'POST' });
    await loadLeaderboard();
    await loadRoutes();
    await loadBikeTable();
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
    await loadRoutes();
    await loadBikeTable();
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
