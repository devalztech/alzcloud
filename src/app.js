require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const fileUpload = require('express-fileupload');
const path = require('path');
const crypto = require('crypto');
const { initDB, pool } = require('../config/db');
const { loadUser } = require('./middleware/auth');
const { attachCsrfToken } = require('./middleware/csrf');
const { downgradeExpiredSubscriptions } = require('./utils/subscriptions');
const routes = require('./routes/index');

const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(fileUpload({
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB max (Pro plan)
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'alzcloud_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(loadUser);
app.use(attachCsrfToken);

app.locals.appName = process.env.APP_NAME || 'AlzCloud';
app.locals.appUrl = process.env.APP_URL || 'http://localhost:3000';
app.locals.paystackPublic = process.env.PAYSTACK_PUBLIC_KEY || '';

// Generate a random admin slug per session — stored in DB for the session lifetime
// The admin path is stored in process.env or regenerated on boot
let ADMIN_SLUG = process.env.ADMIN_SLUG || crypto.randomBytes(6).toString('hex');
app.locals.adminSlug = ADMIN_SLUG;

app.use('/', routes(ADMIN_SLUG));

app.use((req, res) => {
  res.status(404).render('pages/error', { title: '404 — Not Found', message: 'This page does not exist.', user: res.locals.user });
});

const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AlzCloud running on port ${PORT}`);
    console.log(`Admin path: /${ADMIN_SLUG}`);
    console.log(`ENV: ${process.env.NODE_ENV || 'development'}`);
  });

  // Revert lapsed subscriptions to the free plan — once on boot, then hourly.
  // Render keeps this as a persistent process, so no external cron is needed.
  downgradeExpiredSubscriptions().catch(e => console.error('Subscription downgrade check failed:', e));
  setInterval(() => {
    downgradeExpiredSubscriptions().catch(e => console.error('Subscription downgrade check failed:', e));
  }, 60 * 60 * 1000).unref();
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
