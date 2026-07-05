/**
 * Shared helpers for the file-link URL scheme:
 *   API-uploaded file:    /api/:username/:appSlug/:fileId/:filename
 *   Manual/anon upload:   /free/:username/:fileId/:filename
 * The trailing filename is cosmetic only — lookups always use fileId (the
 * file's slug) plus username (+ appSlug for the API channel). A mismatched
 * or missing filename segment is tolerated, never used for lookup.
 */

function slugifyAppName(name) {
  const base = String(name || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'app';
  return base;
}

// Appends a short random suffix to keep (user_id, app_slug) unique without
// rejecting the user's chosen name outright.
function uniqueSuffix() {
  return Math.random().toString(36).substring(2, 6);
}

function buildFileUrl(file, username, appSlug) {
  const safeName = encodeURIComponent(file.original_name || 'file');
  if (file.api_app_id && appSlug) {
    return `/api/${encodeURIComponent(username)}/${encodeURIComponent(appSlug)}/${file.slug}/${safeName}`;
  }
  return `/free/${encodeURIComponent(username || 'anon')}/${file.slug}/${safeName}`;
}

module.exports = { slugifyAppName, uniqueSuffix, buildFileUrl };
