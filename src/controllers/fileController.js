const fs = require('fs');
const { pool } = require('../../config/db');
const { uploadFile, getFileUrl, deleteMessage } = require('../utils/telegram');
const { v4: uuidv4 } = require('uuid');
const bytes = require('bytes');

async function getPlanLimits(planName) {
  const { rows } = await pool.query('SELECT * FROM plans WHERE name=$1', [planName]);
  if (!rows[0]) return { storage: 524288000, fileSize: 524288000, maxFiles: -1, apiAccess: false, liveStreaming: false };
  return {
    storage: Number(rows[0].storage_limit),
    fileSize: Number(rows[0].file_size_limit),
    maxFiles: rows[0].max_files,
    apiAccess: rows[0].api_access,
    liveStreaming: rows[0].live_streaming,
  };
}

exports.getDashboard = async (req, res) => {
  try {
    const { rows: files } = await pool.query(
      'SELECT * FROM files WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]
    );
    const limits = await getPlanLimits(req.user.plan);
    const storagePercent = Math.min(100, Math.round((Number(req.user.storage_used) / limits.storage) * 100));
    files.forEach(f => { f.sizeFormatted = bytes(Number(f.size)); });

    res.render('pages/dashboard', {
      title: 'Dashboard',
      files,
      limits,
      storagePercent,
      storageUsed: bytes(Number(req.user.storage_used)),
      storageMax: bytes(limits.storage),
      fileSizeLimit: bytes(limits.fileSize),
      upgraded: req.query.upgraded === '1'
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Could not load dashboard.', user: req.user });
  }
};

exports.uploadFile = async (req, res) => {
  let tempPath = null;
  try {
    if (!req.files || !req.files.file)
      return res.status(400).json({ error: 'No file provided.' });

    const file = req.files.file;
    const limits = await getPlanLimits(req.user.plan);

    if (file.size > limits.fileSize)
      return res.status(400).json({ error: `File too large. Max allowed is ${bytes(limits.fileSize)}.` });

    const newStorage = Number(req.user.storage_used) + file.size;
    if (newStorage > limits.storage)
      return res.status(400).json({ error: 'Storage limit reached. Upgrade your plan.' });

    if (limits.maxFiles !== -1) {
      const { rows } = await pool.query('SELECT COUNT(*) FROM files WHERE user_id=$1', [req.user.id]);
      if (parseInt(rows[0].count) >= limits.maxFiles)
        return res.status(400).json({ error: `File limit reached (${limits.maxFiles} files max on your plan).` });
    }

    const fileType = file.mimetype.startsWith('video/') ? 'video'
      : file.mimetype.startsWith('image/') ? 'image'
      : file.mimetype.startsWith('audio/') ? 'audio'
      : 'document';

    tempPath = file.tempFilePath;
    const buffer = fs.readFileSync(tempPath);
    const stored = await uploadFile(buffer, file.name, file.mimetype);
    const slug = uuidv4().replace(/-/g, '').substring(0, 12);

    await pool.query(
      `INSERT INTO files (user_id, file_id, file_unique_id, original_name, slug, mime_type, size, file_type, message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.user.id, stored.file_id, stored.file_unique_id, file.name, slug, file.mimetype, file.size, fileType, stored.message_id]
    );
    await pool.query('UPDATE users SET storage_used = storage_used + $1 WHERE id=$2', [file.size, req.user.id]);

    res.json({ success: true, slug, url: `${process.env.APP_URL}/f/${slug}` });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT f.*, u.username, u.plan FROM files f JOIN users u ON f.user_id=u.id WHERE f.slug=$1',
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).render('pages/error', { title: '404', message: 'File not found.', user: res.locals.user });

    const file = rows[0];
    const limits = await getPlanLimits(file.plan);
    const url = `/dl/${file.message_id}`;
    const previewUrl = `/preview/${file.message_id}`;
    const canStream = limits.liveStreaming && file.file_type === 'video';
    // Use HLS for files > 100MB, progressive for smaller
    const streamMode = file.size > 100 * 1024 * 1024 ? 'hls' : 'progressive';

    res.render('pages/file', {
      title: file.original_name,
      file,
      url,
      previewUrl,
      canStream,
      streamMode,
      fileSize: bytes(Number(file.size)),
      appUrl: process.env.APP_URL || ''
    });
  } catch (e) {
    console.error('View file error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Could not retrieve this file.', user: res.locals.user });
  }
};

exports.deleteFile = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM files WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'File not found.' });
    const file = rows[0];
    await deleteMessage(file.message_id);
    await pool.query('UPDATE users SET storage_used = GREATEST(0, storage_used - $1) WHERE id=$2', [file.size, req.user.id]);
    await pool.query('DELETE FROM files WHERE id=$1', [file.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete error:', e);
    res.status(500).json({ error: 'Delete failed.' });
  }
};
