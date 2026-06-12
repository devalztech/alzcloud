/**
 * AlzCloud — Generate Telegram MTProto Session String
 * 
 * Run ONCE locally (not on server):
 *   node scripts/gen_session.js
 * 
 * It will ask for your phone number + OTP code.
 * Copy the printed session string into your .env as TELEGRAM_SESSION=...
 * 
 * You only need to do this once. The session string persists forever
 * unless you terminate the session from Telegram Settings → Devices.
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input'); // npm install input

const API_ID   = 27586230;
const API_HASH = '638e699ca88b5280146a55e959f1fde9';

(async () => {
  console.log('\n🔐 AlzCloud — MTProto Session Generator\n');

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber:  async () => await input.text('📱 Your Telegram phone number (with country code, e.g. +2348012345678): '),
    password:     async () => await input.text('🔑 2FA password (leave blank if none): '),
    phoneCode:    async () => await input.text('📨 OTP code sent to your Telegram: '),
    onError: (err) => console.error('Auth error:', err),
  });

  const sessionString = client.session.save();

  console.log('\n✅ Session generated successfully!\n');
  console.log('━'.repeat(60));
  console.log('Add this to your .env file:\n');
  console.log(`TELEGRAM_SESSION=${sessionString}`);
  console.log('━'.repeat(60));
  console.log('\n⚠️  Keep this string SECRET — it grants full account access.');
  console.log('   Never commit it to git.\n');

  await client.disconnect();
  process.exit(0);
})();
