require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env')
});

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});


async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','storekeeper','technician')),
      phone TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS motors (
      id SERIAL PRIMARY KEY,
      tag TEXT NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      hp REAL,
      voltage INTEGER,
      rpm INTEGER,
      manual_status TEXT DEFAULT 'running',
      current_location TEXT,
      condition_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,

      location_type TEXT DEFAULT '',
      placement_detail TEXT DEFAULT '',
      standby_category TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS spares (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      part_number TEXT,
      category TEXT,
      qty INTEGER DEFAULT 0,
      min_qty INTEGER DEFAULT 0,
      unit_cost REAL DEFAULT 0,
      location TEXT,
      supplier TEXT,
      compatible_motor_ids JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      motor_id INTEGER NOT NULL REFERENCES motors(id),
      reported_at TIMESTAMPTZ NOT NULL,
      reported_by TEXT,
      description TEXT,
      urgency TEXT CHECK(urgency IN ('high','medium','low')) DEFAULT 'medium',
      stage TEXT CHECK(stage IN ('reported','diagnosing','awaiting_parts','in_repair','resolved')) DEFAULT 'reported',
      repair_location TEXT,
      condition_notes TEXT,
      spares_used JSONB DEFAULT '[]',
      timeline JSONB DEFAULT '[]',
      resolved_at TIMESTAMPTZ,
      downtime_hours REAL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,

      repair_location_type TEXT DEFAULT '',
      motor_swaps JSONB DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      entity_label TEXT,
      user_id INTEGER,
      user_name TEXT,
      action TEXT NOT NULL,
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  /*
   * Safe migration:
   * These checks allow the app to work even if the PostgreSQL
   * database already existed before these newer columns were added.
   */

  await ensureColumn(
    'motors',
    'location_type',
    `TEXT DEFAULT ''`
  );

  

  await ensureColumn(
    'motors',
    'placement_detail',
    `TEXT DEFAULT ''`
  );

  await ensureColumn(
    'motors',
    'standby_category',
    `TEXT DEFAULT 'new'`
  );

  await ensureColumn(
    'events',
    'repair_location_type',
    `TEXT DEFAULT ''`
  );

  await ensureColumn(
    'events',
    'motor_swaps',
    `JSONB DEFAULT '[]'::jsonb`
  );

  await ensureColumn('events', 'test_report', "TEXT");

  await ensureAdmin();

  console.log('PostgreSQL database initialized.');
}



async function ensureColumn(table, column, declaration) {
  const result = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    `,
    [table, column]
  );

  if (result.rows.length === 0) {
    // Table and column names are internal constants,
    // not values supplied by users.
    await pool.query(
      `ALTER TABLE public.${table} ADD COLUMN ${column} ${declaration}`
    );

    console.log(`Migrated: added ${table}.${column}`);
  }
}



async function ensureAdmin() {
  const result = await pool.query(
    'SELECT id FROM users LIMIT 1'
  );

  if (result.rows.length > 0) {
    return;
  }

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Admin';

  const hash = bcrypt.hashSync(password, 10);

  await pool.query(
    `
    INSERT INTO users
      (username, password_hash, name, role, created_at)
    VALUES
      ($1, $2, $3, $4, $5)
    `,
    [
      username,
      hash,
      name,
      'admin',
      new Date()
    ]
  );

  console.log(
    `Created first admin account -> username: "${username}". Log in and change the password.`
  );
}


module.exports = {
  pool,
  initDb
};