require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

require('./db/init'); // creates tables + first admin account if needed

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/motors', require('./routes/motors'));
app.use('/api/spares', require('./routes/spares'));
app.use('/api/events', require('./routes/events'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/metrics', require('./routes/metrics'));
app.use('/api/settings', require('./routes/settings'));

// Serve the frontend (the ../frontend folder) as static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`MotorTrack server running on port ${PORT}`));
