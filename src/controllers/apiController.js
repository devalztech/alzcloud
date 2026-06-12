/**
 * AlzCloud Public API
 * Auth: X-API-Key header or ?api_key= query param
 * Only available to Starter and Pro plan users
 */
const fs = require('fs');
const { pool } = require('../../config/db');
const { uploadFile, deleteMessage } = require('../utils/telegram');
const { v4: uuidv4 } = require('uuid');
const bytes = require('bytes');

async function getPlanLimits(planName) {
  const { rows } = await pool.query('SELECT * FROM plans WHERE name=$1', [planName]);
  if (!rows[0]) return { storage: 524288000, fileSize: 524288000 };
  return { storage: Number(rows[0].storage_limit), fileSize: Number(rows[0].file_size_limit) };
}

// GET /api/v1/me
exports.getMe = async (req, res) => {
  const limits = await getPlanLimits(req.user.plan);
  res.json({
    id: req.user.id,
    username: req.user.username,
    email: req.user.email,
    plan: req.user.plan,
    storage_used: req.user.storage_used,
    storage_used_human: bytes(Number(req.user.storage_used)),
    storage_limit: limits.storage,
    storage_limit_human: bytes(limits.storage),
  });
};

// GET /api/v1/files
exports.listFiles = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      'SELECT id, original_name, slug, mime_type, size, file_type, downloads, is_public, created_at FROM files WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.user.id, limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*) FROM files WHERE user_id=$1', [req.user.id]);
    res.json({
      files: rows.map(f => ({
        ...f,
        size_human: bytes(Number(f.size)),
        url: `${process.env.APP_URL}/f/${f.slug}`,
        download_url: `${process.env.APP_URL}/dl/${f.slug}`,
      })),
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
      'SELECT * FROM files WHERE slug=$1 AND user_id=$2',
      [req.params.slug, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'File not found.' });
    const f = rows[0];
    res.json({
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
      url: `${process.env.APP_URL}/f/${f.slug}`,
      download_url: `${process.env.APP_URL}/dl/${f.message_id}`,
      embed_url: `${process.env.APP_URL}/embed/${f.slug}`,
    });
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
    if (newStorage > limits.storage) return res.status(400).json({ error: 'Storage limit reached.' });

    const fileType = file.mimetype.startsWith('video/') ? 'video'
      : file.mimetype.startsWith('image/') ? 'image'
      : file.mimetype.startsWith('audio/') ? 'audio' : 'document';

    tempPath = file.tempFilePath;
    const buffer = fs.readFileSync(tempPath);
    const stored = await uploadFile(buffer, file.name, file.mimetype);
    const slug = uuidv4().replace(/-/g, '').substring(0, 12);

    await pool.query(
      'INSERT INTO files (user_id, file_id, file_unique_id, original_name, slug, mime_type, size, file_type, message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [req.user.id, stored.file_id, stored.file_unique_id, file.name, slug, file.mimetype, file.size, fileType, stored.message_id]
    );
    await pool.query('UPDATE users SET storage_used = storage_used + $1 WHERE id=$2', [file.size, req.user.id]);

    res.status(201).json({
      success: true,
      slug,
      name: file.name,
      size: file.size,
      size_human: bytes(file.size),
      mime_type: file.mimetype,
      file_type: fileType,
      url: `${process.env.APP_URL}/f/${slug}`,
      download_url: `${process.env.APP_URL}/dl/${stored.message_id}`,
      embed_url: `${process.env.APP_URL}/embed/${slug}`,
    });
  } catch (e) {
    console.error('API Upload error:', e);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
};

// DELETE /api/v1/files/:slug
exports.deleteFile = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM files WHERE slug=$1 AND user_id=$2', [req.params.slug, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'File not found.' });
    const file = rows[0];
    await deleteMessage(file.message_id);
    await pool.query('UPDATE users SET storage_used = GREATEST(0, storage_used - $1) WHERE id=$2', [file.size, req.user.id]);
    await pool.query('DELETE FROM files WHERE id=$1', [file.id]);
    res.json({ success: true, message: 'File deleted.' });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed.' });
  }
};

// GET /api/v1/storage
exports.getStorage = async (req, res) => {
  const limits = await getPlanLimits(req.user.plan);
  const used = Number(req.user.storage_used);
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
