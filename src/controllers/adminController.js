const { pool } = require('../../config/db');
const bytes = require('bytes');

exports.getDashboard = async (req, res) => {
  try {
    const [users, files, storage] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM files'),
      pool.query('SELECT SUM(storage_used) FROM users')
    ]);
    const planBreakdown = await pool.query('SELECT plan, COUNT(*) FROM users GROUP BY plan');

    res.render('pages/admin', {
      title: 'Admin Panel',
      stats: {
        users: users.rows[0].count,
        files: files.rows[0].count,
        storage: bytes(Number(storage.rows[0].sum || 0))
      },
      plans: planBreakdown.rows
    });
  } catch (e) {
    console.error('Admin dashboard error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Admin panel failed to load.', user: req.user });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, plan, storage_used, created_at, is_admin FROM users ORDER BY created_at DESC'
    );
    // Pre-format for EJS — no helper functions needed in template
    rows.forEach(u => {
      u.storageFormatted = bytes(Number(u.storage_used));
      u.joinedDate = new Date(u.created_at).toLocaleDateString();
    });
    res.render('pages/admin-users', { title: 'Users — Admin', users: rows });
  } catch (e) {
    console.error('Admin users error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Could not load users.', user: req.user });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed.' });
  }
};

exports.changePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    await pool.query('UPDATE users SET plan=$1 WHERE id=$2', [plan, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Plan change failed.' });
  }
};
