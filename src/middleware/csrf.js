/**
 * Lightweight CSRF protection (synchronizer token pattern) — no external
 * dependency. `csurf` is deprecated upstream, so this is hand-rolled instead.
 *
 * Only covers session-authenticated (cookie-based) routes: web forms and the
 * dashboard/admin fetch calls. The public API (/api/v1/*) is authenticated
 * via X-API-Key, not cookies, so it's not in scope for CSRF and doesn't use
 * this middleware.
 */
const crypto = require('crypto');

// Ensures every session has a token, and exposes it to views/JS as
// res.locals.csrfToken. Runs globally, after the session middleware.
function attachCsrfToken(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

// Verifies the token on state-changing requests. Accepts it from a hidden
// form field (_csrf) or an X-CSRF-Token header (used by fetch/XHR calls).
function verifyCsrfToken(req, res, next) {
  const token = (req.body && req.body._csrf) || req.headers['x-csrf-token'];

  if (!token || !req.session || token !== req.session.csrfToken) {
    const wantsJson = req.path.startsWith('/api/') || req.xhr ||
      (req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      return res.status(403).json({ error: 'Invalid or missing security token. Refresh the page and try again.' });
    }
    return res.status(403).render('pages/error', {
      title: 'Forbidden',
      message: 'Invalid or missing security token. Please refresh the page and try again.',
      user: res.locals.user
    });
  }
  next();
}

module.exports = { attachCsrfToken, verifyCsrfToken };
