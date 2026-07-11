/**
 * Webhook management — authenticated via the app's own X-API-Key, so an
 * integrator never needs a dashboard session to wire up event delivery.
 * Scoped to req.apiApp.id, same isolation model as everything else in the
 * public API: one app's webhooks are invisible to every other app.
 */
const crypto = require('crypto');
const { pool } = require('../../config/db');

const VALID_EVENTS = ['file.uploaded', 'file.deleted'];

function serializeWebhook(w) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    active: w.active,
    last_status: w.last_status,
    last_triggered_at: w.last_triggered_at,
    created_at: w.created_at,
  };
}

// GET /api/v1/webhooks
exports.list = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM webhooks WHERE api_app_id=$1 ORDER BY created_at DESC',
      [req.apiApp.id]
    );
    res.json({ webhooks: rows.map(serializeWebhook) });
  } catch (e) {
    res.status(500).json({ error: 'Could not list webhooks.' });
  }
};

// POST /api/v1/webhooks  { url, events?: ["file.uploaded","file.deleted"] }
// Returns the signing secret ONCE, at creation — used to verify the
// X-AlzCloud-Signature header on delivered payloads (HMAC-SHA256 of the
// raw JSON body). It is never returned again after this response.
exports.create = async (req, res) => {
  try {
    const url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Provide a "url" to receive events.' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http:// or https://.' });

    let events = Array.isArray(req.body.events) && req.body.events.length ? req.body.events : VALID_EVENTS;
    events = events.filter(e => VALID_EVENTS.includes(e));
    if (!events.length) return res.status(400).json({ error: `events must include at least one of: ${VALID_EVENTS.join(', ')}` });

    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM webhooks WHERE api_app_id=$1', [req.apiApp.id]);
    if (parseInt(countRows[0].count) >= 10) {
      return res.status(403).json({ error: 'Maximum of 10 webhooks per app.' });
    }

    const secret = crypto.randomBytes(24).toString('hex');
    const { rows } = await pool.query(
      'INSERT INTO webhooks (api_app_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.apiApp.id, url, JSON.stringify(events), secret]
    );
    res.status(201).json({ success: true, ...serializeWebhook(rows[0]), secret });
  } catch (e) {
    console.error('Create webhook error:', e.message, e.stack);
    res.status(500).json({ error: 'Could not create webhook.' });
  }
};

// DELETE /api/v1/webhooks/:id
exports.remove = async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM webhooks WHERE id=$1 AND api_app_id=$2', [req.params.id, req.apiApp.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Webhook not found.' });
    await pool.query('DELETE FROM webhooks WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete webhook.' });
  }
};
