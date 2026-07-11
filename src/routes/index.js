const express = require('express');
const auth = require('../controllers/authController');
const file = require('../controllers/fileController');
const billing = require('../controllers/billingController');
const admin = require('../controllers/adminController');
const api = require('../controllers/apiController');
const apiApps = require('../controllers/apiAppsController');
const webhooks = require('../controllers/webhooksController');
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

// Open CORS for the routes that exist specifically to be consumed from
// someone else's website/app: the public JSON API and the raw file
// stream/embed endpoints. Nothing session/cookie-authenticated is exposed
// here, so there's no ambient credential a foreign origin could ride on —
// this is the same reasoning documented in middleware/security.js for why
// verifyOrigin exempts API-key routes.
function openCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

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
// Public stream routes — generous since embeds/pages legitimately reload
// these, and video scrubbing fires many small Range requests per second.
const streamLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 600,
  keyFn: req => 'stream:' + req.ip,
  onLimit: (req, res) => res.status(429).send('Too many requests. Please try again shortly.')
});
// Baseline cap across the whole public API, keyed by API key when present.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  keyFn: req => 'api:' + (req.headers['x-api-key'] || req.query.api_key || req.ip)
});
// Separate, tighter limiter for app-credential management (rotate/revoke) —
// session-authenticated, low natural call volume, high blast radius if abused.
const appManageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  keyFn: req => 'app-manage:' + (req.user?.id || req.ip)
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

  // Embed page — iframe-embeddable player/preview for image, video, audio
  // and PDF files. Video is gated by the file owner's plan (live_streaming);
  // every other type is open, matching what the /f/:slug preview page
  // already allows for free. Any API app's files qualify automatically,
  // since API access itself already requires a Starter/Pro plan and both
  // include live_streaming.
  router.get('/embed/:slug', streamLimiter, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT f.*, u.plan, u.username, a.app_slug
         FROM files f LEFT JOIN users u ON f.user_id=u.id
         LEFT JOIN api_apps a ON f.api_app_id = a.id
         WHERE f.slug=$1`,
        [req.params.slug]
      );
      if (!rows[0] || !rows[0].is_public) return res.status(404).send('File not found');
      const f = rows[0];

      if (f.file_type === 'video') {
        const planR = f.plan ? await pool.query('SELECT live_streaming FROM plans WHERE name=$1', [f.plan]) : { rows: [] };
        if (!planR.rows[0]?.live_streaming) {
          return res.status(403).send('<html><body style="background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px"><p>Video embedding requires the file owner to be on Starter or Pro.</p></body></html>');
        }
      }

      const embeddable = ['video', 'image', 'audio'].includes(f.file_type) || f.mime_type === 'application/pdf';
      if (!embeddable) return res.status(415).send('This file type cannot be embedded.');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.render('pages/embed', {
        file: f,
        previewUrl: buildFileUrl(f, f.username, f.app_slug),
        autoplay: req.query.autoplay !== '0',
        muted: req.query.muted === '1',
        loop: req.query.loop === '1',
      });
    } catch (e) {
      console.error('Embed error:', e.message);
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

  // Shared stream handler for both the /free and /api channels. Passes
  // through Range (video/audio seeking), ?size= (image variants) and
  // ?download=1 (force Content-Disposition: attachment). Download counts
  // are only incremented on the *initial* request for a file (no Range
  // header, or a Range starting at byte 0) so that video scrubbing — which
  // fires many small Range requests per playback — doesn't inflate the
  // downloads counter shown on the file page.
  async function handleStream(req, res, fileRow) {
    if (!fileRow || !fileRow.is_public) return res.status(404).send('File not found');
    const range = req.headers.range;
    const isInitialRequest = !range || /^bytes=0-/.test(range);
    if (isInitialRequest) {
      pool.query('UPDATE files SET downloads=downloads+1 WHERE id=$1', [fileRow.id]).catch(() => {});
    }
    await streamFileToResponse(fileRow.message_id, res, {
      range,
      sizeParam: req.query.size,
      download: req.query.download === '1',
    });
  }

  // Manual + anonymous upload channel: /free/:username/:fileId/:filename
  // The filename segment is cosmetic (correct download filename in the
  // browser, readable URL) — lookup always uses fileId, mismatches ignored.
  router.get('/free/:username/:fileId/:filename', streamLimiter, openCors, async (req, res) => {
    try {
      const fileRow = await resolveFreeFile(req.params.username, req.params.fileId);
      await handleStream(req, res, fileRow);
    } catch (e) {
      console.error('Stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not stream file. Please try again.');
    }
  });

  // API upload channel: /api/:username/:appname/:fileId/:filename
  router.get('/api/:username/:appname/:fileId/:filename', streamLimiter, openCors, async (req, res) => {
    try {
      const fileRow = await resolveApiFile(req.params.username, req.params.appname, req.params.fileId);
      await handleStream(req, res, fileRow);
    } catch (e) {
      console.error('Stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not stream file. Please try again.');
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
  router.post('/apps/:id/rotate', requireAuth, appManageLimiter, verifyOrigin, verifyCsrfToken, apiApps.rotate);
  router.patch('/apps/:id', requireAuth, appManageLimiter, verifyOrigin, verifyCsrfToken, apiApps.update);

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
  // Not CSRF-protected: these are authenticated via X-API-Key (server-to-server
  // or direct client-side fetch from an integrator's own site), not cookies,
  // so there's no ambient credential for a foreign origin to forge. CORS is
  // open (openCors) so browser-side JS on a third-party site can call this
  // directly — e.g. an upload widget that posts straight from the visitor's
  // browser without round-tripping through the integrator's own backend.
  router.use('/api/v1', openCors, apiLimiter);
  router.get('/api/v1/status', api.getStatus);
  router.get('/api/v1/me', requireApiKey, api.getMe);
  router.get('/api/v1/usage', requireApiKey, api.getUsage);
  router.get('/api/v1/storage', requireApiKey, api.getStorage);
  router.get('/api/v1/files', requireApiKey, api.listFiles);
  router.get('/api/v1/files/:slug', requireApiKey, api.getFile);
  router.post('/api/v1/upload', requireApiKey, uploadLimiter, api.uploadFile);
  router.patch('/api/v1/files/:slug', requireApiKey, api.updateFile);
  router.delete('/api/v1/files/:slug', requireApiKey, api.deleteFile);
  router.delete('/api/v1/files', requireApiKey, api.deleteFiles);

  // Webhooks — self-service, authenticated by the same API key as everything
  // else above (no dashboard session required to wire these up).
  router.get('/api/v1/webhooks', requireApiKey, webhooks.list);
  router.post('/api/v1/webhooks', requireApiKey, webhooks.create);
  router.delete('/api/v1/webhooks/:id', requireApiKey, webhooks.remove);

  // API docs (public)
  router.get('/api', (req, res) => res.render('pages/api-docs', { title: 'API Documentation', user: res.locals.user }));

  return router;
};
