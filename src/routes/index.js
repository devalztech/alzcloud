const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const file = require('../controllers/fileController');
const billing = require('../controllers/billingController');
const admin = require('../controllers/adminController');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { streamFileToResponse } = require('../utils/telegram');
const { pool } = require('../../config/db');

// Public
router.get('/', (req, res) => res.render('pages/landing', { title: 'AlzCloud — File Hosting Powered by Telegram' }));
router.get('/register', auth.getRegister);
router.post('/register', auth.postRegister);
router.get('/login', auth.getLogin);
router.post('/login', auth.postLogin);
router.get('/logout', auth.logout);
router.get('/plans', billing.getPlans);
router.get('/f/:slug', file.viewFile);

// MTProto streaming download — increments download count here (actual download)
router.get('/dl/:messageId', async (req, res) => {
  try {
    // Increment download count only when the file is actually streamed
    await pool.query('UPDATE files SET downloads=downloads+1 WHERE message_id=$1', [req.params.messageId]);
    await streamFileToResponse(req.params.messageId, res);
  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) {
      res.status(500).send('Could not stream file: ' + e.message);
    }
  }
});

// Protected
router.get('/dashboard', requireAuth, file.getDashboard);
router.post('/upload', requireAuth, file.uploadFile);
router.delete('/files/:id', requireAuth, file.deleteFile);
router.get('/billing/upgrade/:plan', requireAuth, billing.initiate);
router.get('/billing/verify', billing.verify);

// Admin
router.get('/admin', requireAdmin, admin.getDashboard);
router.get('/admin/users', requireAdmin, admin.getUsers);
router.delete('/admin/users/:id', requireAdmin, admin.deleteUser);
router.post('/admin/users/:id/plan', requireAdmin, admin.changePlan);

module.exports = router;
