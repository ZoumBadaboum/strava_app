const fetch = require('node-fetch');
const { pool } = require('./db');

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const REDIRECT_URI = `${BASE_URL}/api/auth/strava/callback`;

function getAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: state || ''
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(member) {
  const now = Math.floor(Date.now() / 1000);
  if (member.expires_at && Number(member.expires_at) > now + 60) {
    return member.access_token;
  }
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: member.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error(`Strava token refresh failed for member ${member.id}: ${res.status}`);
  const data = await res.json();
  await pool.query(
    `UPDATE members SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE id=$4`,
    [data.access_token, data.refresh_token, data.expires_at, member.id]
  );
  return data.access_token;
}

// Fetches all activities newer than the member's last sync (or last 2 years on first sync)
// and upserts them into the database. Returns number of activities stored/updated.
async function syncMemberActivities(member) {
  const accessToken = await refreshAccessToken(member);
  const after = member.last_synced_at
    ? Number(member.last_synced_at) - 60 * 60 * 24 // small overlap window, safe against edits
    : 0; // first sync: entire history (epoch 0 = "since the beginning of time" for Strava's API)

  let page = 1;
  let stored = 0;

  while (true) {
    const url = `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status} ${await res.text()}`);
    const activities = await res.json();
    if (!activities.length) break;

    for (const a of activities) {
      await pool.query(
        `INSERT INTO activities (member_id, strava_id, name, sport_type, distance_m, elevation_m, moving_time_s, start_date, polyline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (strava_id) DO UPDATE SET
           name=EXCLUDED.name, sport_type=EXCLUDED.sport_type, distance_m=EXCLUDED.distance_m,
           elevation_m=EXCLUDED.elevation_m, moving_time_s=EXCLUDED.moving_time_s, start_date=EXCLUDED.start_date,
           polyline=EXCLUDED.polyline`,
        [
          member.id,
          a.id,
          a.name,
          a.sport_type || a.type,
          a.distance || 0,
          a.total_elevation_gain || 0,
          a.moving_time || 0,
          a.start_date,
          (a.map && a.map.summary_polyline) || null
        ]
      );
      stored++;
    }

    if (activities.length < 100) break;
    page++;
  }

  await pool.query(`UPDATE members SET last_synced_at=$1 WHERE id=$2`, [Math.floor(Date.now() / 1000), member.id]);
  return stored;
}

async function syncAllMembers() {
  const { rows: members } = await pool.query(`SELECT * FROM members WHERE status = 'active'`);
  const results = [];
  for (const m of members) {
    try {
      const count = await syncMemberActivities(m);
      results.push({ member: m.display_name, ok: true, newActivities: count });
    } catch (err) {
      results.push({ member: m.display_name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  syncMemberActivities,
  syncAllMembers
};
