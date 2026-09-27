require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'motortrack.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','storekeeper','technician')),
  phone TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS motors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  hp REAL,
  voltage INTEGER,
  rpm INTEGER,
  manual_status TEXT DEFAULT 'running',
  current_location TEXT,
  condition_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  part_number TEXT,
  category TEXT,
  qty INTEGER DEFAULT 0,
  min_qty INTEGER DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  location TEXT,
  supplier TEXT,
  compatible_motor_ids TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  motor_id INTEGER NOT NULL,
  reported_at TEXT NOT NULL,
  reported_by TEXT,
  description TEXT,
  urgency TEXT CHECK(urgency IN ('high','medium','low')) DEFAULT 'medium',
  stage TEXT CHECK(stage IN ('reported','diagnosing','awaiting_parts','in_repair','resolved')) DEFAULT 'reported',
  repair_location TEXT,
  condition_notes TEXT,
  spares_used TEXT DEFAULT '[]',
  timeline TEXT DEFAULT '[]',
  resolved_at TEXT,
  downtime_hours REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(motor_id) REFERENCES motors(id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  entity_label TEXT,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Safe migration: add new columns to an existing live database without
// touching any data already in it. SQLite's ADD COLUMN is safe to run
// only once per column, so we check first.
function ensureColumn(table, column, declaration) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    console.log(`Migrated: added ${table}.${column}`);
  }
}
ensureColumn('motors', 'location_type', "TEXT DEFAULT 'Mill floor'");
ensureColumn('motors', 'placement_detail', "TEXT DEFAULT ''");
ensureColumn('motors', 'standby_category', "TEXT DEFAULT 'new'");
ensureColumn('events', 'repair_location_type', "TEXT DEFAULT ''");
ensureColumn('events', 'motor_swaps', "TEXT DEFAULT '[]'");

// Create the first admin account automatically on first run
function ensureAdmin() {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Admin';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?,?,?,?,?)'
  ).run(username, hash, name, 'admin', new Date().toISOString());
  console.log(`Created first admin account -> username: "${username}". Log in and change the password.`);
}
ensureAdmin();

module.exports = db;
