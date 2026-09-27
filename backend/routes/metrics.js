const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// MTTR (Mean Time To Repair) = average downtime hours across resolved events.
// MTBF (Mean Time Between Failures) = average gap, in hours, between the
// start of one breakdown and the start of the next one on the same motor.
// Both need at least the relevant minimum number of data points to mean
// anything, so we return null (not zero) when there isn't enough history.
router.get('/', requireAuth, (req, res) => {
  const motors = db.prepare('SELECT id, tag, name, department FROM motors').all();
  const events = db.prepare('SELECT * FROM events ORDER BY reported_at ASC').all();

  const perMotor = motors.map(m => {
    const motorEvents = events.filter(e => e.motor_id === m.id);
    const resolved = motorEvents.filter(e => e.downtime_hours != null);
    const mttr = resolved.length ? resolved.reduce((a, e) => a + e.downtime_hours, 0) / resolved.length : null;

    let mtbf = null;
    if (motorEvents.length >= 2) {
      const gaps = [];
      for (let i = 1; i < motorEvents.length; i++) {
        const prev = new Date(motorEvents[i - 1].reported_at).getTime();
        const cur = new Date(motorEvents[i].reported_at).getTime();
        gaps.push((cur - prev) / 3600000);
      }
      mtbf = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    }

    return {
      motorId: m.id, tag: m.tag, name: m.name, department: m.department,
      breakdownCount: motorEvents.length, mttrHours: mttr, mtbfHours: mtbf,
    };
  });

  const allResolved = events.filter(e => e.downtime_hours != null);
  const fleetMttr = allResolved.length ? allResolved.reduce((a, e) => a + e.downtime_hours, 0) / allResolved.length : null;

  res.json({ perMotor, fleetMttrHours: fleetMttr, totalBreakdowns: events.length, totalResolved: allResolved.length });
});

module.exports = router;
