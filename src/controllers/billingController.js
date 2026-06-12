const axios = require('axios');
const { pool } = require('../../config/db');
require('dotenv').config();

const PLAN_PRICES = {
  pro:      { amount: 150000, name: 'AlzCloud Pro' },
  business: { amount: 500000, name: 'AlzCloud Business' }
};

exports.getPlans = async (req, res) => {
  try {
    const { rows: plans } = await pool.query('SELECT * FROM plans WHERE is_active=true ORDER BY price_ngn ASC');
    res.render('pages/plans', {
      title: 'Pricing Plans',
      plans,
      queryError: req.query.error || null
    });
  } catch (e) {
    console.error('Plans error:', e);
    res.status(500).render('pages/error', { title: 'Error', message: 'Could not load plans.', user: res.locals.user });
  }
};

exports.initiate = async (req, res) => {
  const { plan } = req.params;
  if (!PLAN_PRICES[plan]) return res.redirect('/plans');

  try {
    const { data } = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: req.user.email,
      amount: PLAN_PRICES[plan].amount,
      metadata: { user_id: req.user.id, plan },
      callback_url: `${process.env.APP_URL}/billing/verify`
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

    res.redirect(data.data.authorization_url);
  } catch (e) {
    console.error('Paystack initiate error:', e.message);
    res.redirect('/plans?error=payment_failed');
  }
};

exports.verify = async (req, res) => {
  const { reference } = req.query;
  try {
    const { data } = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    if (data.data.status === 'success') {
      const { user_id, plan } = data.data.metadata;
      const expires = new Date();
      expires.setDate(expires.getDate() + 30);

      await pool.query('UPDATE users SET plan=$1 WHERE id=$2', [plan, user_id]);
      await pool.query(
        'INSERT INTO subscriptions (user_id, plan, paystack_ref, amount, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [user_id, plan, reference, data.data.amount, expires]
      );

      res.redirect('/dashboard?upgraded=1');
    } else {
      res.redirect('/plans?error=payment_failed');
    }
  } catch (e) {
    console.error('Paystack verify error:', e.message);
    res.redirect('/plans?error=verification_failed');
  }
};
