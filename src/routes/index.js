const express = require('express');
const auth = require('../controllers/authController');
const file = require('../controllers/fileController');
const billing = require('../controllers/billingController');
const admin = require('../controllers/adminController');
const api = require('../controllers/apiController');
const { requireAuth, requireAdmin, requireApiKey } = require('../middleware/auth');
const { streamFileToResponse } = require('../utils/telegram');
const { pool } = require('../../config/db');

module.exports = function(adminSlug) {
  const router = express.Router();

  // ── Public ──────────────────────────────────────────────────────────────────
  router.get('/', (req, res) => res.render('pages/landing', { title: 'AlzCloud — File Hosting Powered by Telegram' }));
  router.get('/register', auth.getRegister);
  router.post('/register', auth.postRegister);
  router.get('/login', auth.getLogin);
  router.post('/login', auth.postLogin);
  router.get('/logout', auth.logout);
  router.get('/plans', billing.getPlans);
  router.get('/f/:slug', file.viewFile);

  // Embed page (iframe-embeddable video player — paid plans only)
  router.get('/embed/:slug', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT f.*, u.plan FROM files f JOIN users u ON f.user_id=u.id WHERE f.slug=$1',
        [req.params.slug]
      );
      if (!rows[0]) return res.status(404).send('File not found');
      const f = rows[0];
      // Check owner's plan allows streaming
      const planR = await pool.query('SELECT live_streaming FROM plans WHERE name=$1', [f.plan]);
      if (!planR.rows[0]?.live_streaming) {
        return res.status(403).send('<html><body style="background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Live streaming requires Starter or Pro plan.</p></body></html>');
      }
      res.render('pages/embed', { file: f, previewUrl: `/preview/${f.message_id}` });
    } catch (e) {
      res.status(500).send('Error loading embed');
    }
  });

  // File streaming routes
  router.get('/dl/:messageId', async (req, res) => {
    try {
      await pool.query('UPDATE files SET downloads=downloads+1 WHERE message_id=$1', [req.params.messageId]);
      await streamFileToResponse(req.params.messageId, res);
    } catch (e) {
      console.error('Stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not stream file: ' + e.message);
    }
  });

  router.get('/preview/:messageId', async (req, res) => {
    try {
      await streamFileToResponse(req.params.messageId, res);
    } catch (e) {
      console.error('Preview stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Could not preview file: ' + e.message);
    }
  });

  // ── Protected (user) ────────────────────────────────────────────────────────
  router.get('/dashboard', requireAuth, file.getDashboard);
  router.post('/upload', requireAuth, file.uploadFile);
  router.delete('/files/:id', requireAuth, file.deleteFile);
  router.get('/billing/upgrade/:plan', requireAuth, billing.initiate);
  router.get('/billing/verify', billing.verify);

  // ── Admin (dynamic slug) ────────────────────────────────────────────────────
  router.get(`/${adminSlug}`, requireAdmin, admin.getDashboard);
  router.get(`/${adminSlug}/users`, requireAdmin, admin.getUsers);
  router.delete(`/${adminSlug}/users/:id`, requireAdmin, admin.deleteUser);
  router.post(`/${adminSlug}/users/:id/plan`, requireAdmin, admin.changePlan);
  router.post(`/${adminSlug}/plans/:name`, requireAdmin, admin.updatePlan);
  router.get(`/${adminSlug}/stats`, requireAdmin, admin.getLiveStats);

  // Redirect /admin → 404 (security: don't reveal the real path)
  router.get('/admin', (req, res) => res.status(404).render('pages/error', { title: '404', message: 'This page does not exist.', user: res.locals.user }));
  router.get('/admin/*', (req, res) => res.status(404).render('pages/error', { title: '404', message: 'This page does not exist.', user: res.locals.user }));

  // ── SaaS API v1 ─────────────────────────────────────────────────────────────
  router.get('/api/v1/me', requireApiKey, api.getMe);
  router.get('/api/v1/storage', requireApiKey, api.getStorage);
  router.get('/api/v1/files', requireApiKey, api.listFiles);
  router.get('/api/v1/files/:slug', requireApiKey, api.getFile);
  router.post('/api/v1/upload', requireApiKey, api.uploadFile);
  router.delete('/api/v1/files/:slug', requireApiKey, api.deleteFile);

  // API docs (public)
  router.get('/api', (req, res) => res.render('pages/api-docs', { title: 'API Documentation', user: res.locals.user }));

  return router;
};
