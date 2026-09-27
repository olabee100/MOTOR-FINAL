const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  const hours = parseFloat(process.env.JWT_EXPIRES_HOURS || '12');
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: `${hours}h` }
  );
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// Admin: list, create, and remove staff accounts
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, phone, created_at FROM users ORDER BY id').all();
  res.json(users);
});

router.post('/users', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, name, role, phone } = req.body || {};
  if (!username || !password || !name || !role) return res.status(400).json({ error: 'username, password, name and role are required.' });
  if (!['admin', 'storekeeper', 'technician'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username,password_hash,name,role,phone,created_at) VALUES (?,?,?,?,?,?)')
      .run(username, hash, name, role, phone || null, new Date().toISOString());
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That username is already taken.' });
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

router.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't delete your own account while logged in as it." });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

module.exports = router;
