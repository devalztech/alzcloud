const express = require('express');
const auth = require('../controllers/authController');
const file = require('../controllers/fileController');
const billing = require('../controllers/billingController');
const admin = require('../controllers/adminController');
const api = require('../controllers/apiController');
const apiApps = require('../controllers/apiAppsController');
const { requireAuth, requireAdmin, requireApiKey } = require('../middleware/auth');
const { streamFileToResponse } = require('../utils/telegram');
const { pool } = require('../../config/db');
const { rateLimit } = require('../middleware/rateLimit');
const { verifyCsrfToken } = require('../middleware/csrf');
const { verifyOrigin, blockScriptedAuth } = require('../middleware/security');
const { ANON_FILE_SIZE_LIMIT } = require('../utils/plans');
const { buildFileUrl } = require('../utils/urls');

// Reserved path segment for logged-out uploads — see resolveFile() below.
const ANON_NS = 'anon';

// ── Rate limiters ──────────────────────────────────────────────────────────
// Brute-force guard on auth forms. Renders back into the same page so it
// looks like a normal validation error rather than a raw 429.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  keyFn: req => 'login:' + req.ip,
  onLimit: (req, res) => res.status(429).render('pages/login', {
    title: 'Sign In', error: 'Too many attempts. Please wait a few minutes and try again.',
    next: req.body.next || req.query.next || '/dashboard'
  })
});
// Second layer keyed by the submitted email rather than IP — stops
// credential-stuffing against one account spread across many source IPs,
// which a purely IP-based limiter can't catch.
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 6,
  keyFn: req => 'login-email:' + String(req.body.email || '').toLowerCase().trim(),
  onLimit: (req, res) => res.status(429).render('pages/login', {
    title: 'Sign In', error: 'Too many attempts for this account. Please wait a few minutes and try again.',
    next: req.body.next || req.query.next || '/dashboard'
  })
});
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  keyFn: req => 'register:' + req.ip,
  onLimit: (req, res) => res.status(429).render('pages/register', {
    title: 'Create Account', error: 'Too many attempts. Please wait a few minutes and try again.'
  })
});
// Upload keyed by user id (falls back to IP) so one account can't hammer Telegram.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  keyFn: req => 'upload:' + (req.user?.id || req.ip)
});
// Anonymous uploads have no account behind them, so keep this tighter and
// purely IP-based — this is the only throttle standing between the home
// page and unlimited free storage on the Telegram backend.
const anonUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 12,
  keyFn: req => 'anon-upload:' + req.ip,
  onLimit: (req, res) => res.status(429).json({ error: 'Too many uploads from this device. Create a free account to keep uploading, or try again later.' })
});
// Public stream routes — generous since embeds/pages legitimately reload these.
const streamLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 120,
  keyFn: req => 'stream:' + req.ip,
  onLimit: (req, res) => res.status(429).send('Too many requests. Please try again shortly.')
});
// Baseline cap across the whole public API, keyed by API key when present.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  keyFn: req => 'api:' + (req.headers['x-api-key'] || req.query.api_key || req.ip)
});

module.exports = function(adminSlug) {
  const router = express.Router();

  // ── Public ──────────────────────────────────────────────────────────────────
  router.get('/', (req, res) => res.render('pages/landing', { title: 'AlzCloud — Upload & Share', anonMaxBytes: ANON_FILE_SIZE_LIMIT }));
  router.post('/upload/anonymous', anonUploadLimiter, file.anonymousUpload);
  router.get('/register', auth.getRegister);
  router.post('/register', registerLimiter, blockScriptedAuth, verifyOrigin, verifyCsrfToken, auth.postRegister);
  router.get('/login', auth.getLogin);
  router.post('/login', loginLimiter, loginEmailLimiter, blockScriptedAuth, verifyOrigin, verifyCsrfToken, auth.postLogin);
  router.get('/logout', auth.logout);
  router.get('/plans', billing.getPlans);
  router.get('/f/:slug', file.viewFile);

  // Embed page (iframe-embeddable video player — paid plans only)
  router.get('/embed/:slug', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT f.*, u.plan, u.username, a.app_slug
         FROM files f JOIN users u ON f.user_id=u.id
         LEFT JOIN api_apps a ON f.api_app_id = a.id
         WHERE f.slug=$1`,
        [req.params.slug]
      );
      if (!rows[0]) return res.status(404).send('File not found');
      const f = rows[0];
      // Check owner's plan allows streaming
      const planR = await pool.query('SELECT live_streaming FROM plans WHERE name=$1', [f.plan]);
      if (!planR.rows[0]?.live_streaming) {
        return res.status(403).send('<html><body style="background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Live streaming requires Starter or Pro plan.</p></body></html>');
      }
      res.render('pages/embed', { file: f, previewUrl: buildFileUrl(f, f.username, f.app_slug) });
    } catch (e) {
      res.status(500).send('Error loading embed');
    }
  });

  // Look up a file by owner username + slug for the manual/anonymous
  // ("free") channel. Namespaced so files can't be enumerated across users,
  // and excludes API-uploaded files — those live under /api/... only, so
  // every file has exactly one canonical URL. The reserved "anon" namespace
  // covers logged-out uploads (user_id IS NULL).
  async function resolveFreeFile(username, fileId) {
    if (username.toLowerCase() === ANON_NS) {
      const { rows } = await pool.query('SELECT * FROM files WHERE user_id IS NULL AND slug=$1', [fileId]);
      return rows[0] || null;
    }
    const { rows } = await pool.query(
      `SELECT f.* FROM files f JOIN users u ON f.user_id = u.id
       WHERE u.username = $1 AND f.slug = $2 AND f.api_app_id IS NULL`,
      [username.toLowerCase(), fileId]
    );
    return rows[0] || null;
  }

  // Same idea for the API channel — also verifies the file belongs to the
  // NAMED app, not just the user, so one app's files can't be reached
  // through another app's URL even for the same account.
  async function resolveApiFile(username, appSlug, fileId) {
    const { rows } = await pool.query(
      `SELECT f.* FROM files f
       JOIN api_apps a ON f.api_app_id = a.id
       JOIN users u ON a.user_id = u.id
       WHERE u.username = $1 AND a.app_slug = $2 AND f.slug = $3`,
      [username.toLowerCase(), appSlug, fileId]
    );
    return rows[0] || null;
  }

  // Manual + anonymous upload channel: /free/:username/:fileId/:filename
  // The filename segment is cosmetic (correct download filename in the
  // browser, readable URL) — lookup always uses fileId, mismatches ignored.
  router.get('/free/:username/:fileId/:filename', streamLimiter, async (req, res) => {
    try {
      const fileRow = await resolveFreeFile(req.params.username, req.params.fileId);
      if (!fileRow || !fileRow.is_public) return res.status(404).send('File not found');
      await pool.query('UPDATE files SET downloads=downloads+1 WHERE id=$1', [fileRow.id]);
      await streamFileToResponse(fileRow.message_id, res);
    } catch (e) {
      console.error('Stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not stream file: ' + e.message);
    }
  });

  // API upload channel: /api/:username/:appname/:fileId/:filename
  router.get('/api/:username/:appname/:fileId/:filename', streamLimiter, async (req, res) => {
    try {
      const fileRow = await resolveApiFile(req.params.username, req.params.appname, req.params.fileId);
      if (!fileRow || !fileRow.is_public) return res.status(404).send('File not found');
      await pool.query('UPDATE files SET downloads=downloads+1 WHERE id=$1', [fileRow.id]);
      await streamFileToResponse(fileRow.message_id, res);
    } catch (e) {
      console.error('Stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not stream file: ' + e.message);
    }
  });

  // ── Protected (user) ────────────────────────────────────────────────────────
  router.get('/dashboard', requireAuth, file.getDashboard);
  router.post('/upload', requireAuth, uploadLimiter, verifyOrigin, verifyCsrfToken, file.uploadFile);
  router.delete('/files/:id', requireAuth, verifyOrigin, verifyCsrfToken, file.deleteFile);
  router.get('/billing/upgrade/:plan/:cycle', requireAuth, billing.initiate);
  router.get('/billing/verify', billing.verify);

  // My API apps (named keys) — session-authenticated dashboard management.
  router.get('/dashboard/apps', requireAuth, apiApps.page);
  router.post('/apps', requireAuth, verifyOrigin, verifyCsrfToken, apiApps.create);
  router.delete('/apps/:id', requireAuth, verifyOrigin, verifyCsrfToken, apiApps.remove);

  // ── Admin (dynamic slug) ────────────────────────────────────────────────────
  router.get(`/${adminSlug}`, requireAdmin, admin.getDashboard);
  router.get(`/${adminSlug}/users`, requireAdmin, admin.getUsers);
  router.delete(`/${adminSlug}/users/:id`, requireAdmin, verifyOrigin, verifyCsrfToken, admin.deleteUser);
  router.post(`/${adminSlug}/users/:id/plan`, requireAdmin, verifyOrigin, verifyCsrfToken, admin.changePlan);
  router.post(`/${adminSlug}/plans/:name`, requireAdmin, verifyOrigin, verifyCsrfToken, admin.updatePlan);
  router.get(`/${adminSlug}/stats`, requireAdmin, admin.getLiveStats);

  // Redirect /admin → 404 (security: don't reveal the real path)
  router.get('/admin', (req, res) => res.status(404).render('pages/error', { title: '404', message: 'This page does not exist.', user: res.locals.user }));
  router.get('/admin/*', (req, res) => res.status(404).render('pages/error', { title: '404', message: 'This page does not exist.', user: res.locals.user }));

  // ── SaaS API v1 ─────────────────────────────────────────────────────────────
  // Not CSRF-protected: these are authenticated via X-API-Key (server-to-server),
  // not cookies, so there's no ambient credential for a browser to forge.
  router.use('/api/v1', apiLimiter);
  router.get('/api/v1/me', requireApiKey, api.getMe);
  router.get('/api/v1/storage', requireApiKey, api.getStorage);
  router.get('/api/v1/files', requireApiKey, api.listFiles);
  router.get('/api/v1/files/:slug', requireApiKey, api.getFile);
  router.post('/api/v1/upload', requireApiKey, uploadLimiter, api.uploadFile);
  router.patch('/api/v1/files/:slug', requireApiKey, api.updateFile);
  router.delete('/api/v1/files/:slug', requireApiKey, api.deleteFile);

  // API docs (public)
  router.get('/api', (req, res) => res.render('pages/api-docs', { title: 'API Documentation', user: res.locals.user }));

  return router;
};
