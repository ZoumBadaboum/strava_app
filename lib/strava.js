const fetch = require('node-fetch');
const { pool } = require('./db');

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const REDIRECT_URI = `${BASE_URL}/api/auth/strava/callback`;

// Standard cycling benchmark distances we compute best times for, since Strava
// only auto-detects "best efforts" for runs, not rides.
const BIKE_TARGET_DISTANCES = [
  { label: '5 miles', distance_m: 8046.72 },
  { label: '10 km', distance_m: 10000 },
  { label: '10 miles', distance_m: 16093.44 },
  { label: '20 km', distance_m: 20000 },
  { label: '30 km', distance_m: 30000 },
  { label: '40 km', distance_m: 40000 },
  { label: '50 km', distance_m: 50000 },
  { label: '80 km', distance_m: 80000 },
  { label: '50 miles', distance_m: 80467.2 },
  { label: '90 km', distance_m: 90000 },
  { label: '100 km', distance_m: 100000 },
  { label: '150 km', distance_m: 150000 },
  { label: '100 miles', distance_m: 160934.4 },
  { label: '180 km', distance_m: 180000 },
  { label: '200 km', distance_m: 200000 },
  { label: '250 km', distance_m: 250000 },
  { label: '300 km', distance_m: 300000 },
  { label: '350 km', distance_m: 350000 }
];
const SMALLEST_BIKE_TARGET_M = Math.min(...BIKE_TARGET_DISTANCES.map((t) => t.distance_m));
// No artificial cap: process every unanalyzed ride in one go. If we actually
// hit Strava's real rate limit, fetchStreams() throws and the loop below
// stops cleanly — remaining rides just stay unmarked for the next sync.

function isBikeActivity(sportType) {
  return typeof sportType === 'string' && sportType.includes('Ride');
}

// Two-pointer sliding window: fastest time to cover `targetM` metres anywhere
// within one activity's distance/time streams. O(n) since the window only
// ever moves forward (distance stream is cumulative & non-decreasing).
function bestTimeForDistance(distanceArr, timeArr, targetM) {
  const n = distanceArr.length;
  let best = Infinity;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n && distanceArr[j] - distanceArr[i] < targetM) j++;
    if (j >= n) break; // not enough distance left from here on — none of the later starts will work either
    let timeAtTarget;
    if (j === i) {
      timeAtTarget = timeArr[i];
    } else {
      const d0 = distanceArr[j - 1];
      const d1 = distanceArr[j];
      const t0 = timeArr[j - 1];
      const t1 = timeArr[j];
      const neededD = distanceArr[i] + targetM;
      const frac = d1 > d0 ? (neededD - d0) / (d1 - d0) : 0;
      timeAtTarget = t0 + frac * (t1 - t0);
    }
    const elapsed = timeAtTarget - timeArr[i];
    if (elapsed < best) best = elapsed;
  }
  return best === Infinity ? null : best;
}

async function fetchStreams(stravaActivityId, accessToken) {
  const url = `https://www.strava.com/api/v3/activities/${stravaActivityId}/streams?keys=time,distance&key_by_type=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null; // some activities (manual entry, indoor) have no GPS stream
  if (res.status === 429) throw new Error('Limite de requêtes Strava atteinte (429) — le reste sera traité à la prochaine synchro.');
  if (!res.ok) throw new Error(`Strava streams fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.time || !data.distance) return null;
  return { time: data.time.data, distance: data.distance.data };
}

async function processBikeBestEfforts(member, accessToken) {
  const { rows: candidates } = await pool.query(
    `SELECT id, strava_id, distance_m, start_date FROM activities
     WHERE member_id = $1 AND streams_checked = false AND sport_type LIKE '%Ride%' AND distance_m >= $2
     ORDER BY start_date DESC`,
    [member.id, SMALLEST_BIKE_TARGET_M]
  );

  let processed = 0;
  for (const activity of candidates) {
    try {
      const streams = await fetchStreams(activity.strava_id, accessToken);
      if (streams && streams.distance.length > 1) {
        for (const target of BIKE_TARGET_DISTANCES) {
          if (activity.distance_m < target.distance_m) continue;
          const timeS = bestTimeForDistance(streams.distance, streams.time, target.distance_m);
          if (timeS == null) continue;
          await pool.query(
            `INSERT INTO bike_best_efforts (member_id, distance_label, distance_m, best_time_s, achieved_at, activity_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (member_id, distance_label) DO UPDATE SET
               best_time_s = EXCLUDED.best_time_s,
               achieved_at = EXCLUDED.achieved_at,
               activity_id = EXCLUDED.activity_id,
               distance_m = EXCLUDED.distance_m
             WHERE bike_best_efforts.best_time_s > EXCLUDED.best_time_s`,
            [member.id, target.label, target.distance_m, timeS, activity.start_date, activity.id]
          );
        }
      }
      await pool.query(`UPDATE activities SET streams_checked = true WHERE id = $1`, [activity.id]);
      processed++;
    } catch (err) {
      // Likely a rate limit or transient API error — stop for this sync run,
      // this activity (and any after it) stays unmarked and gets retried next time.
      console.warn(`Stream fetch stopped for member ${member.id}:`, err.message);
      break;
    }
  }
  return processed;
}

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

  // Analyze GPS streams of any not-yet-checked ride to compute cycling best
  // efforts (5mi/10km/20km/40km/50km/100km). Rate-limited per call; anything
  // left over is picked up on the next sync.
  await processBikeBestEfforts(member, accessToken);

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
  syncAllMembers,
  BIKE_TARGET_DISTANCES
};
