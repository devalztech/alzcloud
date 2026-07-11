/**
 * Outbound webhooks for API apps — lets an integrator react to
 * file.uploaded / file.deleted instantly instead of polling GET /files.
 *
 * Deliberately fire-and-forget: webhook delivery never blocks or fails the
 * triggering API request. A slow or dead endpoint on the integrator's side
 * should never make an upload/delete request hang or 500.
 */
const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../../config/db');

const DELIVERY_TIMEOUT_MS = 5000;

function sign(secret, payloadString) {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

// event: "file.uploaded" | "file.deleted"
// payload: plain object, e.g. the serialized file
async function fireWebhookEvent(apiAppId, event, payload) {
  if (!apiAppId) return;
  let hooks;
  try {
    const { rows } = await pool.query(
      `SELECT id, url, events, secret FROM webhooks
       WHERE api_app_id=$1 AND active=true AND events @> $2::jsonb`,
      [apiAppId, JSON.stringify([event])]
    );
    hooks = rows;
  } catch (e) {
    console.error('Webhook lookup error:', e.message);
    return;
  }

  if (!hooks.length) return;

  const body = JSON.stringify({ event, data: payload, sent_at: new Date().toISOString() });

  hooks.forEach(async (hook) => {
    const signature = sign(hook.secret, body);
    try {
      await axios.post(hook.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-AlzCloud-Event': event,
          'X-AlzCloud-Signature': signature,
        },
        timeout: DELIVERY_TIMEOUT_MS,
      });
      pool.query(
        'UPDATE webhooks SET last_status=$1, last_triggered_at=NOW() WHERE id=$2',
        ['delivered', hook.id]
      ).catch(() => {});
    } catch (e) {
      pool.query(
        'UPDATE webhooks SET last_status=$1, last_triggered_at=NOW() WHERE id=$2',
        [`failed: ${e.code || e.message}`.substring(0, 20), hook.id]
      ).catch(() => {});
    }
  });
}

module.exports = { fireWebhookEvent, sign };
