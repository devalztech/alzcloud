/**
 * AlzCloud Public API
 * Auth: X-API-Key header or ?api_key= query param
 * Only available to Starter and Pro plan users
 *
 * File operations (list/get/upload/delete/update) are scoped to the
 * calling app (req.apiApp.id), not just the account — each API app only
 * ever sees and manages files it uploaded itself. Storage usage/limits
 * remain account-level since that's the billing unit shared across every
 * app and the dashboard.
 *
 * Every file response includes ready-to-use embed/iframe/download URLs so
 * an integrator can drop a file straight into their site without needing
 * to hand-build any of these — that's the whole point of the "embed_code"
 * and "sizes" fields below.
 */
const fs = require('fs');
const { pool } = require('../../config/db');
const { uploadFile, deleteMessage } = require('../utils/telegram');
const { fireWebhookEvent } = require('../utils/webhooks');
const { v4: uuidv4 } = require('uuid');
const bytes = require('bytes');
const { getPlanLimits, isUnlimited } = require('../utils/plans');
const { buildFileUrl, buildSizedUrl, buildDownloadUrl, buildEmbedUrl, buildEmbedCode } = require('../utils/urls');

function serializeFile(f, username, appSlug) {
  const appUrl = process.env.APP_URL || '';
  const streamUrl = `${appUrl}${buildFileUrl(f, username, appSlug)}`;
  const isImage = f.file_type === 'image';
  const isEmbeddable = ['video', 'image', 'audio'].includes(f.file_type) || f.mime_type === 'application/pdf';

  const out = {
    id: f.id,
    name: f.original_name,
    slug: f.slug,
    mime_type: f.mime_type,
    size: f.size,
    size_human: bytes(Number(f.size)),
    file_type: f.file_type,
    downloads: f.downloads,
    is_public: f.is_public,
    created_at: f.created_at,
    url: `${appUrl}/f/${f.slug}`,
    download_url: buildDownloadUrl(streamUrl),
    stream_url: streamUrl,
  };

  if (isEmbeddable) {
    out.embed_url = buildEmbedUrl(appUrl, f.slug);
    out.embed_code = buildEmbedCode(appUrl, f.slug);
  }

  // Image size variants — served straight off Telegram's own generated
  // sizes, so this needs no local resizing/image-processing dependency.
  if (isImage) {
    out.sizes = {
      small: buildSizedUrl(streamUrl, 'small'),
      medium: buildSizedUrl(streamUrl, 'medium'),
      large: buildSizedUrl(streamUrl, 'large'),
      original: streamUrl,
    };
  }

  return out;
}

// GET /api/v1/status — public, unauthenticated health/version check
exports.getStatus = async (req, res) => {
  res.json({ status: 'ok', version: 'v1', time: new Date().toISOString() });
};

// GET /api/v1/me
exports.getMe = async (req, res) => {
  const limits = await getPlanLimits(req.user.plan);
  const unlimited = isUnlimited(limits.storage);
  res.json({
    id: req.user.id,
    username: req.user.username,
    plan: req.user.plan,
    api_app: req.apiApp?.name || null,
    api_app_slug: req.apiApp?.slug || null,
    storage_used: req.user.storage_used,
    storage_used_human: bytes(Number(req.user.storage_used)),
    storage_limit: unlimited ? null : limits.storage,
    storage_limit_human: unlimited ? 'Unlimited' : bytes(limits.storage),
  });
};

// GET /api/v1/usage — THIS app's request volume + rate-limit context.
// Distinct from /storage (account-wide bytes): this is call volume, scoped
// to the calling key, so an integrator can watch their own throttling state.
exports.getUsage = async (req, res) => {
  try {
    const [last15m, last24h, thisMonth] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM api_logs WHERE api_app_id=$1 AND created_at >= NOW() - INTERVAL '15 minutes'`, [req.apiApp.id]),
      pool.query(`SELECT COUNT(*) FROM api_logs WHERE api_app_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'`, [req.apiApp.id]),
      pool.query(`SELECT COUNT(*) FROM api_logs WHERE api_app_id=$1 AND created_at >= date_trunc('month', NOW())`, [req.apiApp.id]),
    ]);
    res.json({
      api_app: req.apiApp.name,
      requests_last_15m: parseInt(last15m.rows[0].count),
      rate_limit_window: '15m',
      rate_limit_max: 300,
      requests_last_24h: parseInt(last24h.rows[0].count),
      requests_this_month: parseInt(thisMonth.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load usage.' });
  }
};

// GET /api/v1/files — files uploaded by THIS app's key only
exports.listFiles = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      'SELECT * FROM files WHERE api_app_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.apiApp.id, limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*) FROM files WHERE api_app_id=$1', [req.apiApp.id]);
    res.json({
      files: rows.map(f => serializeFile(f, req.user.username, req.apiApp.slug)),
      total: parseInt(total.rows[0].count),
      limit,
      offset,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not list files.' });
  }
};

// GET /api/v1/files/:slug
exports.getFile = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM files WHERE slug=$1 AND api_app_id=$2',
      [req.params.slug, req.apiApp.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'File not found.' });
    res.json(serializeFile(rows[0], req.user.username, req.apiApp.slug));
  } catch (e) {
    res.status(500).json({ error: 'Could not get file.' });
  }
};

// POST /api/v1/upload  (multipart: file field)
exports.uploadFile = async (req, res) => {
  let tempPath = null;
  try {
    if (!req.files || !req.files.file) return res.status(400).json({ error: 'No file provided. Use multipart/form-data with field name "file".' });
    const file = req.files.file;
    const limits = await getPlanLimits(req.user.plan);

    if (file.size > limits.fileSize) return res.status(400).json({ error: `File too large. Max: ${bytes(limits.fileSize)}` });
    const newStorage = Number(req.user.storage_used) + file.size;
    if (!isUnlimited(limits.storage) && newStorage > limits.storage) return res.status(400).json({ error: 'Storage limit reached.' });

    const fileType = file.mimetype.startsWith('video/') ? 'video'
      : file.mimetype.startsWith('image/') ? 'image'
      : file.mimetype.startsWith('audio/') ? 'audio' : 'document';

    tempPath = file.tempFilePath;
    const buffer = fs.readFileSync(tempPath);
    const stored = await uploadFile(buffer, file.name, file.mimetype);
    const slug = uuidv4().replace(/-/g, '').substring(0, 12);

    const { rows } = await pool.query(
      `INSERT INTO files (user_id, file_id, file_unique_id, original_name, slug, mime_type, size, file_type, message_id, api_app_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, stored.file_id, stored.file_unique_id, file.name, slug, file.mimetype, file.size, fileType, stored.message_id, req.apiApp.id]
    );
    await pool.query('UPDATE users SET storage_used = storage_used + $1 WHERE id=$2', [file.size, req.user.id]);

    const serialized = serializeFile(rows[0], req.user.username, req.apiApp.slug);
    fireWebhookEvent(req.apiApp.id, 'file.uploaded', serialized);
    res.status(201).json({ success: true, ...serialized });
  } catch (e) {
    console.error('API Upload error:', e.message, e.stack);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
};

// PATCH /api/v1/files/:slug — rename and/or toggle public visibility
exports.updateFile = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM files WHERE slug=$1 AND api_app_id=$2', [req.params.slug, req.apiApp.id]);
    if (!rows[0]) return res.status(404).json({ error: 'File not found.' });

    const updates = [];
    const values = [];
    let i = 1;
    if (typeof req.body.name === 'string' && req.body.name.trim()) {
      updates.push(`original_name=$${i++}`); values.push(req.body.name.trim().substring(0, 500));
    }
    if (typeof req.body.is_public === 'boolean') {
      updates.push(`is_public=$${i++}`); values.push(req.body.is_public);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update. Provide name and/or is_public.' });

    values.push(rows[0].id);
    const { rows: updated } = await pool.query(
      `UPDATE files SET ${updates.join(', ')} WHERE id=$${i} RETURNING *`, values
    );
    res.json({ success: true, ...serializeFile(updated[0], req.user.username, req.apiApp.slug) });
  } catch (e) {
    res.status(500).json({ error: 'Update failed.' });
  }
};

// DELETE /api/v1/files/:slug
exports.deleteFile = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM files WHERE slug=$1 AND api_app_id=$2', [req.params.slug, req.apiApp.id]);
    if (!rows[0]) return res.status(404).json({ error: 'File not found.' });
    const file = rows[0];
    await deleteMessage(file.message_id);
    await pool.query('UPDATE users SET storage_used = GREATEST(0, storage_used - $1) WHERE id=$2', [file.size, req.user.id]);
    await pool.query('DELETE FROM files WHERE id=$1', [file.id]);
    fireWebhookEvent(req.apiApp.id, 'file.deleted', { slug: file.slug, name: file.original_name });
    res.json({ success: true, message: 'File deleted.' });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed.' });
  }
};

// DELETE /api/v1/files — batch delete: { "slugs": ["a","b","c"] }
// Best-effort: partial failures don't abort the batch, they're reported back.
exports.deleteFiles = async (req, res) => {
  const slugs = Array.isArray(req.body.slugs) ? req.body.slugs.slice(0, 100) : null;
  if (!slugs || slugs.length === 0) return res.status(400).json({ error: 'Provide a "slugs" array (max 100 per request).' });

  const deleted = [];
  const failed = [];
  for (const slug of slugs) {
    try {
      const { rows } = await pool.query('SELECT * FROM files WHERE slug=$1 AND api_app_id=$2', [slug, req.apiApp.id]);
      if (!rows[0]) { failed.push({ slug, error: 'not found' }); continue; }
      const file = rows[0];
      await deleteMessage(file.message_id);
      await pool.query('UPDATE users SET storage_used = GREATEST(0, storage_used - $1) WHERE id=$2', [file.size, req.user.id]);
      await pool.query('DELETE FROM files WHERE id=$1', [file.id]);
      deleted.push(slug);
    } catch (e) {
      failed.push({ slug, error: 'delete failed' });
    }
  }

  if (deleted.length) fireWebhookEvent(req.apiApp.id, 'file.deleted', { slugs: deleted });
  res.json({ success: true, deleted, failed, deleted_count: deleted.length, failed_count: failed.length });
};

// GET /api/v1/storage — account-level (shared across every app + dashboard)
exports.getStorage = async (req, res) => {
  const limits = await getPlanLimits(req.user.plan);
  const used = Number(req.user.storage_used);
  if (isUnlimited(limits.storage)) {
    return res.json({ used, used_human: bytes(used), limit: null, limit_human: 'Unlimited', remaining: null, remaining_human: 'Unlimited', percent: null });
  }
  res.json({
    used,
    used_human: bytes(used),
    limit: limits.storage,
    limit_human: bytes(limits.storage),
    remaining: limits.storage - used,
    remaining_human: bytes(Math.max(0, limits.storage - used)),
    percent: Math.round((used / limits.storage) * 100),
  });
};

module.exports.serializeFile = serializeFile;
