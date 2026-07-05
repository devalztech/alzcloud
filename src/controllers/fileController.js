const fs = require('fs');
const { pool } = require('../../config/db');
const { uploadFile, getFileUrl, deleteMessage } = require('../utils/telegram');
const { v4: uuidv4 } = require('uuid');
const bytes = require('bytes');
const { getPlanLimits, isUnlimited, ANON_FILE_SIZE_LIMIT } = require('../utils/plans');

exports.getDashboard = async (req, res) => {
  try {
    const { rows: files } = await pool.query(
      'SELECT * FROM files WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]
    );
    const limits = await getPlanLimits(req.user.plan);
    const unlimitedStorage = isUnlimited(limits.storage);
    const storagePercent = unlimitedStorage ? 0 : Math.min(100, Math.round((Number(req.user.storage_used) / limits.storage) * 100));
    files.forEach(f => { f.sizeFormatted = bytes(Number(f.size)); });

    const { rows: apiApps } = await pool.query(
      'SELECT id, name, api_key, revoked, created_at FROM api_apps WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]
    );
    const { rows: appCountRows } = await pool.query(
      `SELECT COUNT(*) FROM api_apps WHERE user_id=$1 AND created_at >= date_trunc('month', NOW())`, [req.user.id]
    );

    res.render('pages/dashboard', {
      title: 'Dashboard',
      files,
      limits,
      unlimitedStorage,
      storagePercent,
      storageUsed: bytes(Number(req.user.storage_used)),
      storageMax: unlimitedStorage ? 'Unlimited' : bytes(limits.storage),
      fileSizeLimit: bytes(limits.fileSize),
      apiApps,
      apiAppsThisMonth: parseInt(appCountRows[0].count),
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
    if (!isUnlimited(limits.storage) && newStorage > limits.storage)
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

// Anonymous (logged-out) upload — home page tap-to-upload. Capped at a flat
// 500MB, no account, no dashboard entry (files.user_id is NULL). These are
// always public since there's no owner session to gate visibility behind.
exports.anonymousUpload = async (req, res) => {
  let tempPath = null;
  try {
    if (!req.files || !req.files.file)
      return res.status(400).json({ error: 'No file provided.' });

    const file = req.files.file;
    if (file.size > ANON_FILE_SIZE_LIMIT)
      return res.status(400).json({ error: `File too large. Max allowed without an account is ${bytes(ANON_FILE_SIZE_LIMIT)}.` });

    const fileType = file.mimetype.startsWith('video/') ? 'video'
      : file.mimetype.startsWith('image/') ? 'image'
      : file.mimetype.startsWith('audio/') ? 'audio'
      : 'document';

    tempPath = file.tempFilePath;
    const buffer = fs.readFileSync(tempPath);
    const stored = await uploadFile(buffer, file.name, file.mimetype);
    const slug = uuidv4().replace(/-/g, '').substring(0, 12);

    await pool.query(
      `INSERT INTO files (user_id, file_id, file_unique_id, original_name, slug, mime_type, size, file_type, message_id, is_public)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,true)`,
      [stored.file_id, stored.file_unique_id, file.name, slug, file.mimetype, file.size, fileType, stored.message_id]
    );

    res.json({
      success: true, slug, name: file.name, size: file.size, size_human: bytes(file.size),
      mime_type: file.mimetype, file_type: fileType,
      url: `${process.env.APP_URL}/f/${slug}`,
    });
  } catch (e) {
    console.error('Anonymous upload error:', e);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT f.*, u.username, u.plan FROM files f LEFT JOIN users u ON f.user_id=u.id WHERE f.slug=$1',
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).render('pages/error', { title: '404', message: 'File not found.', user: res.locals.user });

    const file = rows[0];
    const isAnonymous = !file.username;
    const limits = isAnonymous ? null : await getPlanLimits(file.plan);
    const namespace = isAnonymous ? 'anon' : file.username;
    const url = `/dl/${namespace}/${file.slug}`;
    const previewUrl = `/preview/${namespace}/${file.slug}`;
    const canStream = !!limits?.liveStreaming && file.file_type === 'video';
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
