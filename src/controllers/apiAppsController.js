/**
 * Manage a user's API apps — named API keys, quota'd per plan per month.
 * Free plan can't create any (api_access=false). Starter/Pro get a monthly
 * creation quota (max_api_apps) rather than a total cap, so apps made in
 * an earlier month don't count against this month's allowance.
 */
const crypto = require('crypto');
const { pool } = require('../../config/db');
const { getPlanLimits } = require('../utils/plans');
const { slugifyAppName, uniqueSuffix } = require('../utils/urls');

exports.page = async (req, res) => {
  try {
    const limits = await getPlanLimits(req.user.plan);
    const { rows: apps } = await pool.query(
      'SELECT id, name, app_slug, api_key, revoked, created_at, last_rotated_at FROM api_apps WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM api_apps WHERE user_id=$1 AND created_at >= date_trunc('month', NOW())`,
      [req.user.id]
    );
    res.render('pages/dashboard-apps', {
      title: 'API Apps',
      apps,
      limits,
      usedThisMonth: parseInt(countRows[0].count),
    });
  } catch (e) {
    console.error('API apps page error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Could not load your API apps.', user: req.user });
  }
};

exports.list = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, app_slug, api_key, revoked, created_at, last_rotated_at FROM api_apps WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ apps: rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load API apps.' });
  }
};

exports.create = async (req, res) => {
  try {
    const limits = await getPlanLimits(req.user.plan);
    if (!limits.apiAccess) {
      return res.status(403).json({ error: 'API access requires Starter or Pro. Upgrade to create an app.' });
    }

    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give your app a name.' });
    if (name.length > 100) return res.status(400).json({ error: 'Name is too long (max 100 characters).' });

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM api_apps WHERE user_id=$1 AND created_at >= date_trunc('month', NOW())`,
      [req.user.id]
    );
    if (parseInt(countRows[0].count) >= limits.maxApiApps) {
      return res.status(403).json({ error: `You've reached your plan's limit of ${limits.maxApiApps} new API apps this month.` });
    }

    const apiKey = crypto.randomBytes(24).toString('hex');
    let appSlug = slugifyAppName(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows: clash } = await pool.query(
        'SELECT id FROM api_apps WHERE user_id=$1 AND app_slug=$2', [req.user.id, appSlug]
      );
      if (clash.length === 0) break;
      appSlug = `${slugifyAppName(name)}-${uniqueSuffix()}`;
    }

    const { rows } = await pool.query(
      'INSERT INTO api_apps (user_id, name, app_slug, api_key) VALUES ($1,$2,$3,$4) RETURNING id, name, app_slug, api_key, revoked, created_at',
      [req.user.id, name, appSlug, apiKey]
    );
    res.status(201).json({ success: true, app: rows[0] });
  } catch (e) {
    console.error('Create API app error:', e);
    res.status(500).json({ error: 'Could not create API app.' });
  }
};

exports.remove = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM api_apps WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'API app not found.' });
    await pool.query('DELETE FROM api_apps WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete API app.' });
  }
};

// POST /apps/:id/rotate — regenerate the key without deleting the app or its
// files/webhooks. Use this when a key may have leaked; the old key stops
// working the instant this returns.
exports.rotate = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM api_apps WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'API app not found.' });

    const newKey = crypto.randomBytes(24).toString('hex');
    const { rows: updated } = await pool.query(
      'UPDATE api_apps SET api_key=$1, last_rotated_at=NOW() WHERE id=$2 RETURNING id, name, app_slug, api_key, revoked, created_at, last_rotated_at',
      [newKey, req.params.id]
    );
    res.json({ success: true, app: updated[0] });
  } catch (e) {
    console.error('Rotate API key error:', e);
    res.status(500).json({ error: 'Could not rotate API key.' });
  }
};

// PATCH /apps/:id — { revoked: true|false } — pause/resume a key without
// losing the app's file history (unlike delete, which orphans its files).
exports.update = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM api_apps WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'API app not found.' });
    if (typeof req.body.revoked !== 'boolean') return res.status(400).json({ error: 'Provide "revoked": true or false.' });

    const { rows: updated } = await pool.query(
      'UPDATE api_apps SET revoked=$1 WHERE id=$2 RETURNING id, name, app_slug, api_key, revoked, created_at, last_rotated_at',
      [req.body.revoked, req.params.id]
    );
    res.json({ success: true, app: updated[0] });
  } catch (e) {
    res.status(500).json({ error: 'Could not update API app.' });
  }
};
