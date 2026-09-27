const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  const hours = parseFloat(process.env.JWT_EXPIRES_HOURS || '12');

  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    },
    process.env.JWT_SECRET,
    {
      expiresIn: `${hours}h`
    }
  );
}


// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required.'
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({
        error: 'Incorrect username or password.'
      });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role
      }
    });

  } catch (err) {
    console.error('Login error:', err);

    res.status(500).json({
      error: 'Could not log in.'
    });
  }
});


// CURRENT USER
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.user
  });
});


// ADMIN: LIST STAFF ACCOUNTS
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        username,
        name,
        role,
        phone,
        created_at
      FROM users
      ORDER BY id
    `);

    res.json(result.rows);

  } catch (err) {
    console.error('List users error:', err);

    res.status(500).json({
      error: 'Could not load users.'
    });
  }
});


// ADMIN: CREATE STAFF ACCOUNT
router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      username,
      password,
      name,
      role,
      phone
    } = req.body || {};

    if (!username || !password || !name || !role) {
      return res.status(400).json({
        error: 'username, password, name and role are required.'
      });
    }

    if (!['admin', 'storekeeper', 'technician'].includes(role)) {
      return res.status(400).json({
        error: 'Invalid role.'
      });
    }

    const hash = bcrypt.hashSync(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users
        (
          username,
          password_hash,
          name,
          role,
          phone,
          created_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [
        username,
        hash,
        name,
        role,
        phone || null,
        new Date()
      ]
    );

    res.status(201).json({
      id: result.rows[0].id
    });

  } catch (err) {
    console.error('Create user error:', err);

    // PostgreSQL unique constraint violation
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'That username is already taken.'
      });
    }

    res.status(500).json({
      error: 'Could not create the account.'
    });
  }
});


// ADMIN: DELETE STAFF ACCOUNT
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (userId === req.user.id) {
      return res.status(400).json({
        error: "You can't delete your own account while logged in as it."
      });
    }

    const result = await pool.query(
      'DELETE FROM users WHERE id = $1',
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    res.json({
      ok: true
    });

  } catch (err) {
    console.error('Delete user error:', err);

    res.status(500).json({
      error: 'Could not delete the user.'
    });
  }
});


// CHANGE PASSWORD
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const {
      currentPassword,
      newPassword
    } = req.body || {};

    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows[0];

    if (
      !user ||
      !bcrypt.compareSync(
        currentPassword || '',
        user.password_hash
      )
    ) {
      return res.status(401).json({
        error: 'Current password is incorrect.'
      });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        error: 'New password must be at least 6 characters.'
      });
    }

    const hash = bcrypt.hashSync(newPassword, 10);

    await pool.query(
      `
      UPDATE users
      SET password_hash = $1
      WHERE id = $2
      `,
      [
        hash,
        user.id
      ]
    );

    res.json({
      ok: true
    });

  } catch (err) {
    console.error('Change password error:', err);

    res.status(500).json({
      error: 'Could not change the password.'
    });
  }
});


module.exports = router;