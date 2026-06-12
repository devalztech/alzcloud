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
        storage_limit BIGINT NOT NULL,
        file_size_limit BIGINT NOT NULL,
        max_files INTEGER DEFAULT -1,
        features JSONB DEFAULT '[]',
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(20) NOT NULL,
        paystack_ref VARCHAR(255),
        amount INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Upsert plans — always keeps values current even after first deploy
    await client.query(`
      INSERT INTO plans (name, display_name, price_ngn, storage_limit, file_size_limit, max_files, features)
      VALUES
        ('free',     'Free',     0,    2621440000,   524288000,  5,   '["5 files", "500MB per file", "2.5GB total", "Public links"]'),
        ('pro',      'Pro',      1500, 10737418240,  524288000,  500, '["500 files", "500MB per file", "10GB total", "Download stats"]'),
        ('business', 'Business', 5000, 107374182400, 2147483648, -1,  '["Unlimited files", "2GB per file", "100GB total", "API access", "Priority support"]')
      ON CONFLICT (name) DO UPDATE SET
        display_name   = EXCLUDED.display_name,
        price_ngn      = EXCLUDED.price_ngn,
        storage_limit  = EXCLUDED.storage_limit,
        file_size_limit = EXCLUDED.file_size_limit,
        max_files      = EXCLUDED.max_files,
        features       = EXCLUDED.features;
    `);

    // Make confidencerich97@gmail.com admin if the account exists
    await client.query(`
      UPDATE users SET is_admin = true WHERE email = 'confidencerich97@gmail.com';
    `);

    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
