const bcrypt = require('bcryptjs');
const { pool } = require('../../config/db');

const RESERVED_USERNAMES = ['anon', 'anonymous', 'admin', 'api', 'root', 'support', 'alzcloud'];

exports.getRegister = (req, res) => res.render('pages/register', { title: 'Create Account', error: null });
exports.getLogin = (req, res) => res.render('pages/login', { title: 'Sign In', error: null, next: req.query.next || '/dashboard' });

exports.postRegister = async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.render('pages/register', { title: 'Create Account', error: 'All fields required.' });
  if (password.length < 6)
    return res.render('pages/register', { title: 'Create Account', error: 'Password must be at least 6 characters.' });
  if (RESERVED_USERNAMES.includes(username.toLowerCase()))
    return res.render('pages/register', { title: 'Create Account', error: 'That username is reserved. Please choose another.' });
  try {
    const hash = await bcrypt.hash(password, 10);
    // No api_key here — Free plan has no API access. A key is only ever
    // created when the user makes an API app after upgrading (apiAppsController).
    const r = await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1,$2,$3) RETURNING id, is_admin',
      [username.toLowerCase(), email.toLowerCase(), hash]
    );
    req.session.userId = r.rows[0].id;
    req.session.isAdmin = r.rows[0].is_admin;
    // Generate new admin slug each login for admins
    if (r.rows[0].is_admin) {
      const crypto = require('crypto');
      req.session.adminSlug = crypto.randomBytes(6).toString('hex');
    }
    res.redirect('/dashboard');
  } catch (e) {
    const msg = e.code === '23505' ? 'Username or email already taken.' : 'Registration failed. Try again.';
    res.render('pages/register', { title: 'Create Account', error: msg });
  }
};

exports.postLogin = async (req, res) => {
  const { email, password } = req.body;
  const next = req.body.next || '/dashboard';
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows[0]) return res.render('pages/login', { title: 'Sign In', error: 'Invalid credentials.', next });
    const ok = await bcrypt.compare(password, r.rows[0].password);
    if (!ok) return res.render('pages/login', { title: 'Sign In', error: 'Invalid credentials.', next });
    req.session.userId = r.rows[0].id;
    req.session.isAdmin = r.rows[0].is_admin;
    res.redirect(next);
  } catch (e) {
    res.render('pages/login', { title: 'Sign In', error: 'Login failed.', next });
  }
};

exports.logout = (req, res) => {
  req.session.destroy(() => res.redirect('/'));
};
