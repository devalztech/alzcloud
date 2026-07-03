const express = require('express');
const auth = require('../controllers/authController');
const file = require('../controllers/fileController');
const billing = require('../controllers/billingController');
const admin = require('../controllers/adminController');
const api = require('../controllers/apiController');
const { requireAuth, requireAdmin, requireApiKey } = require('../middleware/auth');
const { streamFileToResponse } = require('../utils/telegram');
const { pool } = require('../../config/db');
const { rateLimit } = require('../middleware/rateLimit');
const { verifyCsrfToken } = require('../middleware/csrf');

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
  router.get('/', (req, res) => res.render('pages/landing', { title: 'AlzCloud — File Hosting Powered by Telegram' }));
  router.get('/register', auth.getRegister);
  router.post('/register', registerLimiter, verifyCsrfToken, auth.postRegister);
  router.get('/login', auth.getLogin);
  router.post('/login', loginLimiter, verifyCsrfToken, auth.postLogin);
  router.get('/logout', auth.logout);
  router.get('/plans', billing.getPlans);
  router.get('/f/:slug', file.viewFile);

  // Embed page (iframe-embeddable video player — paid plans only)
  router.get('/embed/:slug', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT f.*, u.plan, u.username FROM files f JOIN users u ON f.user_id=u.id WHERE f.slug=$1',
        [req.params.slug]
      );
      if (!rows[0]) return res.status(404).send('File not found');
      const f = rows[0];
      // Check owner's plan allows streaming
      const planR = await pool.query('SELECT live_streaming FROM plans WHERE name=$1', [f.plan]);
      if (!planR.rows[0]?.live_streaming) {
        return res.status(403).send('<html><body style="background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Live streaming requires Starter or Pro plan.</p></body></html>');
      }
      res.render('pages/embed', { file: f, previewUrl: `/preview/${f.username}/${f.slug}` });
    } catch (e) {
      res.status(500).send('Error loading embed');
    }
  });

  // Look up a file by owner username + slug. Namespaced so one developer's
  // files can never be enumerated or guessed via another developer's URLs,
  // and so the internal Telegram message_id is never exposed publicly.
  async function resolveFile(username, slug) {
    const { rows } = await pool.query(
      `SELECT f.* FROM files f JOIN users u ON f.user_id = u.id
       WHERE u.username = $1 AND f.slug = $2`,
      [username.toLowerCase(), slug]
    );
    return rows[0] || null;
  }

  // File streaming routes — /dl/:username/:slug (namespaced, public files only)
  router.get('/dl/:username/:slug', streamLimiter, async (req, res) => {
    try {
      const file = await resolveFile(req.params.username, req.params.slug);
      if (!file || !file.is_public) return res.status(404).send('File not found');
      await pool.query('UPDATE files SET downloads=downloads+1 WHERE id=$1', [file.id]);
      await streamFileToResponse(file.message_id, res);
    } catch (e) {
      console.error('Stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not stream file: ' + e.message);
    }
  });

  router.get('/preview/:username/:slug', streamLimiter, async (req, res) => {
    try {
      const file = await resolveFile(req.params.username, req.params.slug);
      if (!file || !file.is_public) return res.status(404).send('File not found');
      await streamFileToResponse(file.message_id, res);
    } catch (e) {
      console.error('Preview stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not preview file: ' + e.message);
    }
  });

  // ── Protected (user) ────────────────────────────────────────────────────────
  router.get('/dashboard', requireAuth, file.getDashboard);
  router.post('/upload', requireAuth, uploadLimiter, verifyCsrfToken, file.uploadFile);
  router.delete('/files/:id', requireAuth, verifyCsrfToken, file.deleteFile);
  router.get('/billing/upgrade/:plan', requireAuth, billing.initiate);
  router.get('/billing/verify', billing.verify);

  // ── Admin (dynamic slug) ────────────────────────────────────────────────────
  router.get(`/${adminSlug}`, requireAdmin, admin.getDashboard);
  router.get(`/${adminSlug}/users`, requireAdmin, admin.getUsers);
  router.delete(`/${adminSlug}/users/:id`, requireAdmin, verifyCsrfToken, admin.deleteUser);
  router.post(`/${adminSlug}/users/:id/plan`, requireAdmin, verifyCsrfToken, admin.changePlan);
  router.post(`/${adminSlug}/plans/:name`, requireAdmin, verifyCsrfToken, admin.updatePlan);
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
  router.delete('/api/v1/files/:slug', requireApiKey, api.deleteFile);

  // API docs (public)
  router.get('/api', (req, res) => res.render('pages/api-docs', { title: 'API Documentation', user: res.locals.user }));

  return router;
};
