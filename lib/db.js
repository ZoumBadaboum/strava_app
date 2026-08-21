const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL non défini — connecte une base Postgres (ex: Supabase) dans .env');
}

// Supabase (and most managed Postgres) require SSL, but present a certificate
// that Node won't validate against a local CA bundle by default — this is the
// standard, documented way to connect from a simple Node app like this one.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      athlete_id BIGINT UNIQUE,
      access_token TEXT,
      refresh_token TEXT,
      expires_at BIGINT,
      avatar_url TEXT,
      last_synced_at BIGINT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      strava_id BIGINT UNIQUE NOT NULL,
      name TEXT,
      sport_type TEXT,
      distance_m REAL,
      elevation_m REAL,
      moving_time_s INTEGER,
      start_date TEXT,
      polyline TEXT
    );
  `);

  // Safe to run on every boot: adds the column only if it's missing, so an
  // already-existing Supabase database (created before this feature existed)
  // upgrades itself automatically on the next deploy.
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS polyline TEXT;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activities_member ON activities(member_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(start_date);`);
}

module.exports = { pool, init };
