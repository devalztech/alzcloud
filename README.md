# ☁️ AlzCloud

A full-stack SaaS file hosting platform that uses **Telegram as a storage backend** — zero storage costs, unlimited capacity.

---

## Features

- 📁 Upload files, images, videos, audio to Telegram
- 🔗 Instant public shareable links
- 👤 User accounts with plan-based limits
- 💳 Paystack payment integration (NGN)
- 📊 Download stats per file
- 🛡️ Admin panel (user management, plan control)
- 🌑 Clean dark UI

## Plans

| Plan | Storage | File size | Price |
|------|---------|-----------|-------|
| Free | 500MB | 50MB | ₦0 |
| Pro | 10GB | 500MB | ₦1,500/mo |
| Business | 100GB | 2GB | ₦5,000/mo |

---

## Setup

### 1. Prerequisites

- Node.js 18+
- PostgreSQL database
- Telegram bot token + channel
- Paystack account

### 2. Create Telegram Bot & Channel

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Create a private Telegram channel
3. Add your bot as an **admin** with permission to post messages
4. Get the channel ID:
   - Forward a message from the channel to [@username_to_id_bot](https://t.me/username_to_id_bot)
   - Or use: `https://api.telegram.org/bot<TOKEN>/getUpdates` and post to the channel

### 3. Install & Configure

```bash
git clone <repo>
cd alzcloud
npm install
cp .env.example .env
# Edit .env with your values
```

### 4. Database Setup

Create a PostgreSQL database:
```sql
CREATE DATABASE alzcloud;
```

The app auto-creates all tables on first start.

### 5. Make yourself admin

After registering your account, run:
```sql
UPDATE users SET is_admin = true WHERE email = 'your@email.com';
```

### 6. Run

```bash
npm start         # production
npm run dev       # development (nodemon)
```

---

## Deployment

### Fly.io

```bash
fly launch
fly secrets set DATABASE_URL="..." TELEGRAM_BOT_TOKEN="..." TELEGRAM_CHANNEL_ID="..." PAYSTACK_SECRET_KEY="..." SESSION_SECRET="..."
fly deploy
```

### Render / Railway

Set the environment variables from `.env.example` in the dashboard and deploy.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/f/:slug` | View/download a file |
| POST | `/upload` | Upload a file (auth required) |
| DELETE | `/files/:id` | Delete a file (auth required) |
| GET | `/billing/upgrade/:plan` | Start Paystack checkout |

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Storage:** Telegram Bot API
- **Payments:** Paystack
- **Frontend:** EJS + Vanilla CSS + JS
