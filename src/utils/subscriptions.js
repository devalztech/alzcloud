/**
 * Reverts users to the free plan once their paid subscription lapses.
 * `subscriptions.expires_at` was being written on payment but never read —
 * this closes that gap. Runs on boot and hourly (see app.js); no external
 * cron is needed since Render keeps the web service running as one process.
 */
const { pool } = require('../../config/db');

async function downgradeExpiredSubscriptions() {
  const client = await pool.connect();
  try {
    // Mark lapsed subscriptions as expired.
    const { rows } = await client.query(`
      UPDATE subscriptions
      SET status = 'expired'
      WHERE status = 'active' AND expires_at < NOW()
      RETURNING user_id
    `);

    if (rows.length === 0) return { downgraded: 0 };

    const userIds = [...new Set(rows.map(r => r.user_id))];

    // Only drop a user to 'free' if they have no OTHER active, unexpired
    // subscription — covers renewals or a plan change that landed mid-cycle.
    const result = await client.query(`
      UPDATE users
      SET plan = 'free'
      WHERE id = ANY($1::int[])
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.user_id = users.id AND s.status = 'active' AND s.expires_at >= NOW()
        )
      RETURNING id
    `, [userIds]);

    if (result.rows.length > 0) {
      console.log(`Downgraded ${result.rows.length} expired subscription(s) to free.`);
    }
    return { downgraded: result.rows.length };
  } finally {
    client.release();
  }
}

module.exports = { downgradeExpiredSubscriptions };
