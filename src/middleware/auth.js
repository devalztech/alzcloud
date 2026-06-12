const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).render('pages/error', { title: 'Access Denied', message: 'Admins only.', user: null });
  }
  next();
};

const loadUser = async (req, res, next) => {
  if (req.session.userId) {
    const { pool } = require('../../config/db');
    try {
      const r = await pool.query('SELECT id, username, email, plan, storage_used, is_admin, api_key FROM users WHERE id=$1', [req.session.userId]);
      if (r.rows[0]) {
        req.user = r.rows[0];
        res.locals.user = r.rows[0];
      }
    } catch (e) { /* ignore */ }
  } else {
    res.locals.user = null;
  }
  next();
};

// API key authentication middleware
const requireApiKey = async (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API key required. Pass X-API-Key header.' });
  const { pool } = require('../../config/db');
  try {
    const r = await pool.query('SELECT id, username, email, plan, storage_used, api_key FROM users WHERE api_key=$1', [key]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid API key.' });
    const user = r.rows[0];
    // Check plan allows API access
    const planR = await pool.query('SELECT api_access FROM plans WHERE name=$1', [user.plan]);
    if (!planR.rows[0]?.api_access) {
      return res.status(403).json({ error: 'API access is not available on your plan. Upgrade to Starter or Pro.' });
    }
    req.user = user;
    // Log API usage
    pool.query('INSERT INTO api_logs (user_id, endpoint, method) VALUES ($1,$2,$3)', [user.id, req.path, req.method]).catch(() => {});
    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth failed.' });
  }
};

module.exports = { requireAuth, requireAdmin, loadUser, requireApiKey };
