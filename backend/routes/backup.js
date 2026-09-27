// Backup/restore — a safety net for hosting plans that don't keep a
// persistent disk (e.g. Render's free tier). Admins can download a full
// snapshot of everything before the service restarts, and load it back
// in afterwards.
const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/export', requireAuth, requireRole('admin'), (req, res) => {
  const dump = {
    exportedAt: new Date().toISOString(),
    version: 1,
    users: db.prepare('SELECT * FROM users').all(),
    motors: db.prepare('SELECT * FROM motors').all(),
    spares: db.prepare('SELECT * FROM spares').all(),
    events: db.prepare('SELECT * FROM events').all(),
  };
  res.setHeader('Content-Disposition', `attachment; filename="motortrack-backup-${Date.now()}.json"`);
  res.json(dump);
});

// Replaces ALL current data with what's in the uploaded backup file.
router.post('/import', requireAuth, requireRole('admin'), (req, res) => {
  const dump = req.body || {};
  if (!dump.motors || !dump.spares || !dump.events || !dump.users) {
    return res.status(400).json({ error: 'That file does not look like a MotorTrack backup.' });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM spares').run();
    db.prepare('DELETE FROM motors').run();
    db.prepare('DELETE FROM users').run();

    const insUser = db.prepare(`INSERT INTO users (id,username,password_hash,name,role,phone,created_at) VALUES (?,?,?,?,?,?,?)`);
    dump.users.forEach(u => insUser.run(u.id, u.username, u.password_hash, u.name, u.role, u.phone, u.created_at));

    const insMotor = db.prepare(`INSERT INTO motors (id,tag,name,department,hp,voltage,rpm,manual_status,current_location,condition_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    dump.motors.forEach(m => insMotor.run(m.id, m.tag, m.name, m.department, m.hp, m.voltage, m.rpm, m.manual_status, m.current_location, m.condition_notes, m.created_at, m.updated_at));

    const insSpare = db.prepare(`INSERT INTO spares (id,name,part_number,category,qty,min_qty,unit_cost,location,supplier,compatible_motor_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    dump.spares.forEach(s => insSpare.run(s.id, s.name, s.part_number, s.category, s.qty, s.min_qty, s.unit_cost, s.location, s.supplier, s.compatible_motor_ids, s.created_at, s.updated_at));

    const insEvent = db.prepare(`INSERT INTO events (id,motor_id,reported_at,reported_by,description,urgency,stage,repair_location,condition_notes,spares_used,timeline,resolved_at,downtime_hours,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    dump.events.forEach(e => insEvent.run(e.id, e.motor_id, e.reported_at, e.reported_by, e.description, e.urgency, e.stage, e.repair_location, e.condition_notes, e.spares_used, e.timeline, e.resolved_at, e.downtime_hours, e.created_at, e.updated_at));

    // Restored rows keep their original IDs, so the auto-increment counters
    // must be pushed forward — otherwise the next NEW record created after
    // a restore could reuse an ID that's already taken.
    ['users', 'motors', 'spares', 'events'].forEach(table => {
      const max = db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM ${table}`).get().m;
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
      db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(table, max);
    });
  });
  try {
    tx();
    res.json({ ok: true, restored: { users: dump.users.length, motors: dump.motors.length, spares: dump.spares.length, events: dump.events.length } });
  } catch (e) {
    res.status(500).json({ error: 'Restore failed: ' + e.message });
  }
});

module.exports = router;
