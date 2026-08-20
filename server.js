require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { pool, init } = require('./lib/db');
const strava = require('./lib/strava');

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_ACCESS_CODE = process.env.SITE_ACCESS_CODE || '';
const ADMIN_CODE = process.env.ADMIN_CODE || '';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'change-me-please';

if (!SITE_ACCESS_CODE || !ADMIN_CODE) {
  console.warn('⚠️  SITE_ACCESS_CODE et/ou ADMIN_CODE ne sont pas définis dans .env — le site sera inaccessible tant que ce n\'est pas fait.');
}

app.use(express.json());
app.use(cookieParser(COOKIE_SECRET));

const ACCESS_COOKIE = 'ca_access';
const ADMIN_COOKIE = 'ca_admin';
const COOKIE_OPTS = { httpOnly: true, signed: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 180 };

function hasAccess(req) {
  return req.signedCookies[ACCESS_COOKIE] === 'granted';
}
function isAdmin(req) {
  return req.signedCookies[ADMIN_COOKIE] === 'granted';
}
function requireAccess(req, res, next) {
  if (!hasAccess(req)) return res.status(401).json({ ok: false, error: 'access_required' });
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_required' });
  next();
}

// index.html / css / js stay public — no data lives there, only the API is gated
app.use(express.static(path.join(__dirname, 'public')));

// ---- Session / codes ----

app.get('/api/session', (req, res) => {
  res.json({ access: hasAccess(req), admin: isAdmin(req) });
});

app.post('/api/access', (req, res) => {
  const { code } = req.body || {};
  if (!SITE_ACCESS_CODE || code !== SITE_ACCESS_CODE) {
    return res.status(401).json({ ok: false, error: 'wrong_code' });
  }
  res.cookie(ACCESS_COOKIE, 'granted', COOKIE_OPTS);
  res.json({ ok: true });
});

app.post('/api/admin', (req, res) => {
  if (!hasAccess(req)) return res.status(401).json({ ok: false, error: 'access_required' });
  const { code } = req.body || {};
  if (!ADMIN_CODE || code !== ADMIN_CODE) {
    return res.status(401).json({ ok: false, error: 'wrong_code' });
  }
  res.cookie(ADMIN_COOKIE, 'granted', { ...COOKIE_OPTS, maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(ACCESS_COOKIE);
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

// ---- Auth: connect a family member's Strava account ----
// Anyone who already knows the site access code can start a connection,
// but the new member only becomes visible/synced once an admin approves it.

app.get('/api/auth/strava/connect', requireAccess, (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).send('Paramètre "name" manquant.');
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).send('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET non configurés côté serveur (fichier .env).');
  }
  res.redirect(strava.getAuthorizeUrl(name));
});

app.get('/api/auth/strava/callback', requireAccess, async (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    return res.redirect(`/?connect=denied`);
  }
  try {
    const token = await strava.exchangeCodeForToken(code);
    const displayName = state || `${token.athlete.firstname} ${token.athlete.lastname}`;

    const { rows: existingRows } = await pool.query(`SELECT id, status FROM members WHERE athlete_id = $1`, [token.athlete.id]);
    const existing = existingRows[0];

    if (existing) {
      // Re-authorizing an existing member refreshes their token but doesn't change their status
      // (an already-active member stays active, a still-pending one stays pending).
      await pool.query(
        `UPDATE members SET access_token=$1, refresh_token=$2, expires_at=$3, avatar_url=$4, display_name=$5 WHERE id=$6`,
        [token.access_token, token.refresh_token, token.expires_at, token.athlete.profile, displayName, existing.id]
      );
      return res.redirect(existing.status === 'active' ? '/?connect=success' : '/?connect=pending');
    }

    await pool.query(
      `INSERT INTO members (display_name, athlete_id, access_token, refresh_token, expires_at, avatar_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [displayName, token.athlete.id, token.access_token, token.refresh_token, token.expires_at, token.athlete.profile]
    );
    res.redirect('/?connect=pending');
  } catch (err) {
    console.error(err);
    res.redirect('/?connect=error');
  }
});

// ---- Members ----

// Public roster: only approved members are visible
app.get('/api/members', requireAccess, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, display_name, avatar_url, last_synced_at FROM members WHERE status = 'active' ORDER BY display_name`
  );
  res.json(rows);
});

// Admin-only: people waiting for approval
app.get('/api/members/pending', requireAccess, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, display_name, avatar_url, created_at FROM members WHERE status = 'pending' ORDER BY created_at`
  );
  res.json(rows);
});

app.post('/api/members/:id/approve', requireAccess, requireAdmin, async (req, res) => {
  const result = await pool.query(`UPDATE members SET status = 'active' WHERE id = $1`, [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

// Works for both rejecting a pending request and removing an already-active member
app.delete('/api/members/:id', requireAccess, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query(`DELETE FROM activities WHERE member_id = $1`, [id]);
  await pool.query(`DELETE FROM members WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// Trigger a sync of every connected member's activities from Strava
app.post('/api/sync', requireAccess, async (req, res) => {
  try {
    const results = await strava.syncAllMembers();
    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Stats & leaderboard ----

function periodStartDate(period) {
  const now = new Date();
  if (period === 'week') {
    const day = (now.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(now);
    monday.setDate(now.getDate() - day);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString();
  }
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
  if (period === 'year') {
    return new Date(now.getFullYear(), 0, 1).toISOString();
  }
  return '1970-01-01T00:00:00Z'; // all time
}

app.get('/api/leaderboard', requireAccess, async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const sport = req.query.sport || 'all';
    const since = periodStartDate(period);

    const { rows: members } = await pool.query(
      `SELECT id, display_name, avatar_url, last_synced_at FROM members WHERE status = 'active'`
    );

    const leaderboard = await Promise.all(members.map(async (m) => {
      const { rows: statRows } = await pool.query(
        `SELECT
           COUNT(*)::int as activity_count,
           COALESCE(SUM(distance_m), 0) as total_distance,
           COALESCE(SUM(elevation_m), 0) as total_elevation,
           COALESCE(SUM(moving_time_s), 0) as total_time
         FROM activities
         WHERE member_id = $1 AND start_date >= $2
         AND ($3 = 'all' OR sport_type = $3)`,
        [m.id, since, sport]
      );
      const stats = statRows[0];

      const { rows: sportRows } = await pool.query(
        `SELECT sport_type FROM activities WHERE member_id = $1 AND start_date >= $2 GROUP BY sport_type ORDER BY COUNT(*) DESC`,
        [m.id, since]
      );

      const totalDistance = Number(stats.total_distance);
      const totalElevation = Number(stats.total_elevation);
      const totalTime = Number(stats.total_time);
      const avgSpeedKmh = totalTime > 0 ? (totalDistance / 1000) / (totalTime / 3600) : 0;

      return {
        id: m.id,
        name: m.display_name,
        avatar: m.avatar_url,
        lastSynced: m.last_synced_at,
        activityCount: stats.activity_count,
        distanceKm: Math.round((totalDistance / 1000) * 10) / 10,
        elevationM: Math.round(totalElevation),
        timeHours: Math.round((totalTime / 3600) * 10) / 10,
        avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
        sports: sportRows.map((s) => s.sport_type)
      };
    }));

    const { rows: availableSportRows } = await pool.query(
      `SELECT DISTINCT a.sport_type FROM activities a
       JOIN members m ON m.id = a.member_id
       WHERE a.start_date >= $1 AND m.status = 'active'
       ORDER BY a.sport_type`,
      [since]
    );

    res.json({
      period,
      sport,
      members: leaderboard,
      availableSports: availableSportRows.map((s) => s.sport_type)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Carnets d'Ascension — http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Impossible d\'initialiser la base de données. Vérifie DATABASE_URL dans .env.', err);
    process.exit(1);
  });
