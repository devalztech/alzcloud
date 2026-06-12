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
      const r = await pool.query('SELECT id, username, email, plan, storage_used, is_admin FROM users WHERE id=$1', [req.session.userId]);
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

module.exports = { requireAuth, requireAdmin, loadUser };
