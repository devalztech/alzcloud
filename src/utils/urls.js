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

// Direct stream URL with an optional Telegram-native size variant appended
// (images only — see streamFileToResponse). Passing null/undefined size
// omits the query param entirely and serves the original.
function buildSizedUrl(baseUrl, size) {
  if (!size || size === 'original') return baseUrl;
  return `${baseUrl}?size=${encodeURIComponent(size)}`;
}

// A forced-download variant of the same stream URL (Content-Disposition:
// attachment instead of inline) — for "Download" buttons on embedder sites
// that can't rely on the cross-origin quirks of the HTML <a download> attribute.
function buildDownloadUrl(baseUrl) {
  return baseUrl.includes('?') ? `${baseUrl}&download=1` : `${baseUrl}?download=1`;
}

function buildEmbedUrl(appUrl, slug) {
  return `${appUrl}/embed/${slug}`;
}

// Ready-to-paste <iframe> snippet — this is the whole point of "embed
// without hassle": the API hands back working HTML, not just a URL.
function buildEmbedCode(appUrl, slug, opts = {}) {
  const width = opts.width || '100%';
  const height = opts.height || 360;
  return `<iframe src="${buildEmbedUrl(appUrl, slug)}" width="${width}" height="${height}" frameborder="0" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe>`;
}

module.exports = { slugifyAppName, uniqueSuffix, buildFileUrl, buildSizedUrl, buildDownloadUrl, buildEmbedUrl, buildEmbedCode };
