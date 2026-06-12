const { pool } = require('../../config/db');
const bytes = require('bytes');

const PROTECTED_EMAIL = 'confidencerich97@gmail.com';

exports.getDashboard = async (req, res) => {
  try {
    const [users, files, storage, revenue, newUsersToday, filesThisWeek, planBreakdown, recentUsers, topFiles] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM files'),
      pool.query('SELECT SUM(storage_used) FROM users'),
      pool.query("SELECT SUM(amount) FROM subscriptions WHERE status='active'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM files WHERE created_at > NOW() - INTERVAL '7 days'"),
      pool.query('SELECT plan, COUNT(*) as count FROM users GROUP BY plan ORDER BY count DESC'),
      pool.query('SELECT id, username, email, plan, created_at FROM users ORDER BY created_at DESC LIMIT 8'),
      pool.query('SELECT original_name, downloads, size, file_type FROM files ORDER BY downloads DESC LIMIT 5'),
    ]);

    const [planRows, allUsers] = await Promise.all([
      pool.query('SELECT * FROM plans WHERE is_active=true ORDER BY price_ngn ASC'),
      pool.query('SELECT id, username, email, plan, storage_used, created_at, is_admin FROM users ORDER BY created_at DESC'),
    ]);

    res.render('pages/admin', {
      title: 'Admin',
      stats: {
        users: parseInt(users.rows[0].count),
        files: parseInt(files.rows[0].count),
        storage: bytes(Number(storage.rows[0].sum || 0)),
        storageRaw: Number(storage.rows[0].sum || 0),
        revenue: Number(revenue.rows[0].sum || 0) / 100,
        newUsersToday: parseInt(newUsersToday.rows[0].count),
        filesThisWeek: parseInt(filesThisWeek.rows[0].count),
      },
      planBreakdown: planBreakdown.rows,
      recentUsers: recentUsers.rows.map(u => ({
        ...u,
        joinedDate: new Date(u.created_at).toLocaleDateString()
      })),
      topFiles: topFiles.rows.map(f => ({ ...f, sizeFormatted: bytes(Number(f.size)) })),
      plans: planRows.rows,
      users: allUsers.rows.map(u => ({
        ...u,
        storageFormatted: bytes(Number(u.storage_used)),
        joinedDate: new Date(u.created_at).toLocaleDateString(),
        isProtected: u.email === PROTECTED_EMAIL,
      })),
      adminUser: req.user,
    });
  } catch (e) {
    console.error('Admin dashboard error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Admin panel failed to load.', user: req.user });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const search = req.query.search || '';
    const plan = req.query.plan || '';
    let q = 'SELECT id, username, email, plan, storage_used, created_at, is_admin FROM users';
    const params = [];
    const conds = [];
    if (search) { params.push(`%${search}%`); conds.push(`(username ILIKE $${params.length} OR email ILIKE $${params.length})`); }
    if (plan) { params.push(plan); conds.push(`plan=$${params.length}`); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(q, params);
    rows.forEach(u => {
      u.storageFormatted = bytes(Number(u.storage_used));
      u.joinedDate = new Date(u.created_at).toLocaleDateString();
      u.isProtected = u.email === PROTECTED_EMAIL;
    });
    res.render('pages/admin-users', { title: 'Users', users: rows, search, planFilter: plan });
  } catch (e) {
    console.error('Admin users error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Could not load users.', user: req.user });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    if (rows[0].email === PROTECTED_EMAIL) return res.status(403).json({ error: 'This admin account cannot be deleted.' });
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed.' });
  }
};

exports.changePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    const valid = ['free','starter','pro'];
    if (!valid.includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
    await pool.query('UPDATE users SET plan=$1 WHERE id=$2', [plan, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Plan change failed.' });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const { name } = req.params;
    const { display_name, price_ngn, storage_limit_gb, file_size_limit_gb, api_access, live_streaming } = req.body;
    await pool.query(`
      UPDATE plans SET
        display_name=$1, price_ngn=$2,
        storage_limit=$3, file_size_limit=$4,
        api_access=$5, live_streaming=$6
      WHERE name=$7
    `, [
      display_name,
      parseInt(price_ngn),
      Math.round(parseFloat(storage_limit_gb) * 1024 * 1024 * 1024),
      Math.round(parseFloat(file_size_limit_gb) * 1024 * 1024 * 1024),
      api_access === 'true' || api_access === true,
      live_streaming === 'true' || live_streaming === true,
      name
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error('Plan update error:', e);
    res.status(500).json({ error: 'Plan update failed.' });
  }
};

exports.getLiveStats = async (req, res) => {
  try {
    const [users, files, storage, revenue, newToday, apiCalls] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM files'),
      pool.query('SELECT SUM(storage_used) FROM users'),
      pool.query("SELECT SUM(amount) FROM subscriptions WHERE status='active'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM api_logs WHERE created_at > NOW() - INTERVAL '24 hours'"),
    ]);
    res.json({
      users: parseInt(users.rows[0].count),
      files: parseInt(files.rows[0].count),
      storage: Number(storage.rows[0].sum || 0),
      revenue: Number(revenue.rows[0].sum || 0) / 100,
      newToday: parseInt(newToday.rows[0].count),
      apiCalls24h: parseInt(apiCalls.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: 'Stats failed.' });
  }
};
