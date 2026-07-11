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

// Session-theft guard: binds a session to the User-Agent seen at login. A
// cookie replayed from a wildly different client (different browser/OS
// entirely) gets the session dropped rather than honored. Not foolproof —
// UA is attacker-controllable in principle — but it raises the bar against
// casual cookie theft/replay for near-zero cost, and never blocks a normal
// user on their own device.
const sessionGuard = (req, res, next) => {
  if (req.session.userId) {
    const currentUa = req.headers['user-agent'] || '';
    if (req.session.ua && req.session.ua !== currentUa) {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      });
    }
    if (!req.session.ua) req.session.ua = currentUa;
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

// API key authentication middleware — keys now live in api_apps (one user
// can have several named apps), not the legacy single users.api_key column.
const requireApiKey = async (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API key required. Pass X-API-Key header.' });
  const { pool } = require('../../config/db');
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.email, u.plan, u.storage_used, a.id AS api_app_id, a.name AS api_app_name, a.app_slug AS api_app_slug
       FROM api_apps a JOIN users u ON a.user_id = u.id
       WHERE a.api_key=$1 AND a.revoked=false`,
      [key]
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid or revoked API key.' });
    const user = r.rows[0];
    // Check plan allows API access — re-checked live so an expired
    // subscription immediately cuts off every app's key, not just new ones.
    const planR = await pool.query('SELECT api_access FROM plans WHERE name=$1', [user.plan]);
    if (!planR.rows[0]?.api_access) {
      return res.status(403).json({ error: 'API access is not available on your plan. Upgrade to Starter or Pro.' });
    }
    req.user = user;
    req.apiApp = { id: user.api_app_id, name: user.api_app_name, slug: user.api_app_slug };

    // Log API usage — written once the response actually finishes, so the
    // real status code is captured (not just "request arrived"). Scoped to
    // this app (api_app_id), which is what GET /api/v1/usage reads back.
    res.on('finish', () => {
      pool.query(
        'INSERT INTO api_logs (user_id, api_app_id, endpoint, method, status_code) VALUES ($1,$2,$3,$4,$5)',
        [user.id, user.api_app_id, req.path, req.method, res.statusCode]
      ).catch(() => {});
    });

    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth failed.' });
  }
};

module.exports = { requireAuth, requireAdmin, loadUser, requireApiKey, sessionGuard };
