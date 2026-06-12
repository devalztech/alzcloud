require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const fileUpload = require('express-fileupload');
const path = require('path');
const { initDB, pool } = require('../config/db');
const { loadUser } = require('./middleware/auth');
const routes = require('./routes/index');

const app = express();

// Render sits behind a proxy — required for HTTPS cookies and correct IPs
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(fileUpload({
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

// PostgreSQL session store — no MemoryStore leak in production
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'sessions',
    createTableIfMissing: true  // auto-creates the sessions table
  }),
  secret: process.env.SESSION_SECRET || 'alzcloud_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS-only on Render
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(loadUser);

app.locals.appName = process.env.APP_NAME || 'AlzCloud';
app.locals.appUrl = process.env.APP_URL || 'http://localhost:3000';
app.locals.paystackPublic = process.env.PAYSTACK_PUBLIC_KEY || '';

app.use('/', routes);

app.use((req, res) => {
  res.status(404).render('pages/error', { title: '404 — Not Found', message: 'This page does not exist.', user: res.locals.user });
});

const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 AlzCloud running on port ${PORT}`);
    console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   URL: ${process.env.APP_URL || 'http://localhost:' + PORT}`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
