const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        plan VARCHAR(20) DEFAULT 'free',
        storage_used BIGINT DEFAULT 0,
        api_key VARCHAR(64) UNIQUE,
        is_admin BOOLEAN DEFAULT false,
        is_verified BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        file_id VARCHAR(255) NOT NULL,
        file_unique_id VARCHAR(255),
        original_name VARCHAR(500) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        mime_type VARCHAR(100),
        size BIGINT DEFAULT 0,
        file_type VARCHAR(20),
        message_id INTEGER,
        downloads INTEGER DEFAULT 0,
        is_public BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        price_ngn INTEGER DEFAULT 0,
        price_ngn_yearly INTEGER DEFAULT 0,
        storage_limit BIGINT NOT NULL,
        file_size_limit BIGINT NOT NULL,
        max_files INTEGER DEFAULT -1,
        max_api_apps INTEGER DEFAULT 0,
        api_access BOOLEAN DEFAULT false,
        live_streaming BOOLEAN DEFAULT false,
        features JSONB DEFAULT '[]',
        is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS api_apps (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        app_slug VARCHAR(120),
        api_key VARCHAR(64) UNIQUE NOT NULL,
        revoked BOOLEAN DEFAULT false,
        last_rotated_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        api_app_id INTEGER REFERENCES api_apps(id) ON DELETE CASCADE,
        url VARCHAR(500) NOT NULL,
        events JSONB DEFAULT '["file.uploaded","file.deleted"]',
        secret VARCHAR(64) NOT NULL,
        active BOOLEAN DEFAULT true,
        last_status VARCHAR(20),
        last_triggered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(20) NOT NULL,
        billing_cycle VARCHAR(10) DEFAULT 'monthly',
        paystack_ref VARCHAR(255),
        amount INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS api_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        api_app_id INTEGER REFERENCES api_apps(id) ON DELETE SET NULL,
        endpoint VARCHAR(255),
        method VARCHAR(10),
        status_code INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS api_access BOOLEAN DEFAULT false;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS live_streaming BOOLEAN DEFAULT false;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_ngn_yearly INTEGER DEFAULT 0;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_api_apps INTEGER DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) DEFAULT 'monthly';
      ALTER TABLE api_apps ADD COLUMN IF NOT EXISTS app_slug VARCHAR(120);
      ALTER TABLE api_apps ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMP;
      ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS api_app_id INTEGER REFERENCES api_apps(id) ON DELETE SET NULL;
      ALTER TABLE files ADD COLUMN IF NOT EXISTS api_app_id INTEGER REFERENCES api_apps(id) ON DELETE SET NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_logs_app_created ON api_logs (api_app_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_webhooks_app_active ON webhooks (api_app_id, active);
      CREATE INDEX IF NOT EXISTS idx_files_api_app ON files (api_app_id);
    `);

    // Plan matrix. storage_limit = -1 means unlimited (Free: capped per-file,
    // uncapped total — anonymous uploads never persist a plan row at all,
    // they're handled as a fixed 500MB ceiling in code).
    await client.query(`
      INSERT INTO plans (name, display_name, price_ngn, price_ngn_yearly, storage_limit, file_size_limit, max_files, max_api_apps, api_access, live_streaming, features)
      VALUES
        ('free',    'Free',    0,    0,     -1,            524288000,   -1, 0,  false, false, '["500MB per file", "Unlimited total storage", "No API access"]'),
        ('starter', 'Starter', 3000, 25000, 107374182400,  1073741824, -1, 5,  true,  true,  '["1GB per file (web + API)", "100GB API storage", "Up to 5 API apps / month", "Live streaming"]'),
        ('pro',     'Pro',     5000, 30000, 536870912000,  2147483648, -1, 10, true,  true,  '["2GB per file (web + API)", "500GB API storage", "Up to 10 API apps / month", "Live streaming", "Priority support"]')
      ON CONFLICT (name) DO UPDATE SET
        display_name     = EXCLUDED.display_name,
        price_ngn        = EXCLUDED.price_ngn,
        price_ngn_yearly = EXCLUDED.price_ngn_yearly,
        storage_limit    = EXCLUDED.storage_limit,
        file_size_limit  = EXCLUDED.file_size_limit,
        max_files        = EXCLUDED.max_files,
        max_api_apps     = EXCLUDED.max_api_apps,
        api_access       = EXCLUDED.api_access,
        live_streaming   = EXCLUDED.live_streaming,
        features         = EXCLUDED.features;
    `);

    await client.query(`DELETE FROM plans WHERE name NOT IN ('free','starter','pro');`);

    // One-time migration: fold each user's legacy single api_key into the
    // new multi-app api_apps table so nothing breaks for existing keys.
    await client.query(`
      INSERT INTO api_apps (user_id, name, api_key, created_at)
      SELECT id, 'Default', api_key, created_at FROM users
      WHERE api_key IS NOT NULL
      ON CONFLICT (api_key) DO NOTHING;
    `);

    // Backfill app_slug for any api_apps row that predates that column
    // (existing "Default" apps from the migration above, or older rows).
    // Done in JS since uniqueness-per-user needs a de-dupe check per row.
    const { slugifyAppName, uniqueSuffix } = require('../src/utils/urls');
    const { rows: needsSlug } = await client.query(`SELECT id, user_id, name FROM api_apps WHERE app_slug IS NULL`);
    for (const app of needsSlug) {
      let slug = slugifyAppName(app.name);
      let attempt = 0;
      while (attempt < 5) {
        const { rows: clash } = await client.query(
          'SELECT id FROM api_apps WHERE user_id=$1 AND app_slug=$2 AND id != $3',
          [app.user_id, slug, app.id]
        );
        if (clash.length === 0) break;
        slug = `${slugifyAppName(app.name)}-${uniqueSuffix()}`;
        attempt++;
      }
      await client.query('UPDATE api_apps SET app_slug=$1 WHERE id=$2', [slug, app.id]);
    }

    await client.query(`UPDATE users SET is_admin = true WHERE email = 'confidencerich97@gmail.com';`);

    console.log('Database initialized');
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
