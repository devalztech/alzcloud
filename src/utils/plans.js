/**
 * Shared plan-limit lookups. Was previously duplicated in fileController
 * and apiController — centralized here so the two never drift apart.
 *
 * storage_limit / max_files of -1 in the `plans` table means "unlimited".
 * Anonymous (logged-out) uploads never touch this table — they're a fixed
 * 500MB-per-file ceiling enforced directly in fileController.anonymousUpload.
 */
const { pool } = require('../../config/db');

const UNLIMITED = -1;
const ANON_FILE_SIZE_LIMIT = 500 * 1024 * 1024; // 500MB

async function getPlanLimits(planName) {
  const { rows } = await pool.query('SELECT * FROM plans WHERE name=$1', [planName]);
  if (!rows[0]) {
    // Fallback to Free's shape if a plan row is ever missing/renamed.
    return {
      storage: UNLIMITED, fileSize: 524288000, maxFiles: UNLIMITED,
      maxApiApps: 0, apiAccess: false, liveStreaming: false,
      displayName: 'Free', priceMonthly: 0, priceYearly: 0
    };
  }
  const p = rows[0];
  return {
    storage: Number(p.storage_limit),
    fileSize: Number(p.file_size_limit),
    maxFiles: p.max_files,
    maxApiApps: p.max_api_apps,
    apiAccess: p.api_access,
    liveStreaming: p.live_streaming,
    displayName: p.display_name,
    priceMonthly: p.price_ngn,
    priceYearly: p.price_ngn_yearly,
  };
}

function isUnlimited(n) {
  return n === UNLIMITED || n < 0;
}

module.exports = { getPlanLimits, isUnlimited, UNLIMITED, ANON_FILE_SIZE_LIMIT };
