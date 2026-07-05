/**
 * Baseline security headers, applied to every response.
 *
 * /embed/:slug is deliberately excluded from framing restrictions — its
 * entire purpose is to be iframed on third-party sites, so locking that
 * down would break the one feature that needs the opposite policy.
 *
 * CSP here allows 'unsafe-inline' for scripts/styles because the app uses
 * inline <script>/<style> blocks throughout rather than a nonce-based
 * build step — this still meaningfully restricts which external origins
 * can load scripts/fonts/frames, but isn't a strict XSS-proof CSP. Tightening
 * that further would mean threading a per-request nonce through every page.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  res.setHeader('X-XSS-Protection', '0'); // deprecated; explicitly off rather than inconsistently honored

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  const isEmbed = req.path.startsWith('/embed/');
  if (!isEmbed) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }

  const frameAncestors = isEmbed ? 'frame-ancestors *;' : "frame-ancestors 'self';";
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "media-src 'self'",
    "connect-src 'self'",
    frameAncestors,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '));

  next();
}

// Defense-in-depth alongside CSRF tokens: for state-changing session
// requests, reject if Origin is present and clearly foreign. Browsers always
// send Origin on cross-site POSTs; same-site requests either omit it or
// match. API-key routes are exempt — they're not cookie-authenticated, so
// there's no ambient credential for a foreign origin to ride on.
function verifyOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host;
    const appHost = new URL(process.env.APP_URL || `https://${req.headers.host}`).host;
    if (originHost !== req.headers.host && originHost !== appHost) {
      return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
  } catch (e) { /* malformed Origin header — fall through to CSRF check */ }
  next();
}

// Scripted-client signatures with no legitimate reason to ever submit a
// login/register form — no human uses these to type a password, and no
// search-engine crawler submits credentials, so this list has effectively
// zero false-positive risk when scoped to auth POSTs specifically.
const SCRIPT_SIGNATURES = [
  /python-requests/i, /python-urllib/i, /scrapy/i, /go-http-client/i,
  /libwww/i, /httpclient\//i, /okhttp/i, /axios\/0/i, /^curl\//i, /^wget\//i,
];

// Strict guard for account-sensitive POSTs (login/register). Deliberately
// NOT applied to page views — a blanket bot denylist there would also catch
// Googlebot/Bingbot and break the SEO on the public pages, and would risk
// blocking curl/wget for the direct file-download links, which is a
// legitimate, expected use case for a file host.
function blockScriptedAuth(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (!ua || SCRIPT_SIGNATURES.some(p => p.test(ua))) {
    return res.status(403).render('pages/error', {
      title: 'Forbidden',
      message: "This request looks automated. Please use a regular browser to sign in or register.",
      user: null
    });
  }
  next();
}

// Light, low-risk header check applied broadly: just require *a*
// User-Agent be present. Every real browser, curl, wget, and HTTP client
// library sends one by default — this only catches bare-socket scripts that
// deliberately strip it, which is a safe, near-zero-false-positive signal.
function requireUserAgent(req, res, next) {
  if (!req.headers['user-agent']) {
    return res.status(400).send('Request rejected: missing required headers.');
  }
  next();
}

module.exports = { securityHeaders, verifyOrigin, blockScriptedAuth, requireUserAgent };
