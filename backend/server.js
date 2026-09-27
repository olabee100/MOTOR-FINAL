require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDb } = require('./db/init');

const app = express();


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: '10mb'
  })
);


// ============================================================
// API ROUTES
// ============================================================

app.use('/api/auth', require('./routes/auth'));
app.use('/api/motors', require('./routes/motors'));
app.use('/api/spares', require('./routes/spares'));
app.use('/api/events', require('./routes/events'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/metrics', require('./routes/metrics'));
app.use('/api/settings', require('./routes/settings'));


// ============================================================
// FRONTEND
// ============================================================

// Serve the frontend from ../frontend
app.use(
  express.static(
    path.join(__dirname, '..', 'frontend')
  )
);


// Handle frontend routes
app.get('*', (req, res, next) => {

  // Let API routes continue to their own handlers
  if (req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(
    path.join(
      __dirname,
      '..',
      'frontend',
      'index.html'
    )
  );
});


// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {

  console.error(err);

  res.status(500).json({
    error: 'Something went wrong on the server.'
  });
});


// ============================================================
// START SERVER AFTER DATABASE INITIALIZATION
// ============================================================

const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {

    app.listen(PORT, () => {
      console.log(
        `MotorTrack server running on port ${PORT}`
      );
    });

  })
  .catch(err => {

    console.error(
      'Database initialization failed:',
      err
    );

    process.exit(1);
  });