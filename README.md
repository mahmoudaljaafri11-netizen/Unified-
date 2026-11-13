# Unified Inbox

صندوق رسايل موحد: واتساب + إنستجرام + ماسنجر + تلجرام في مكان واحد، مع بوت رد تلقائي وأخذ أوردرات من الشات.
One inbox for WhatsApp, Instagram, Messenger and Telegram, with an auto-reply bot that also takes orders.

## Features
- **Unified inbox**: all channels in one list, search, filters, unread, "Needs reply", resolve, tags, internal notes. Live updates.
- **Auto-reply bot**: keyword replies, greeting, fallback, hand-off to a human. It stays silent in a chat for N minutes after *you* reply.
- **Orders**: a customer says "I want to order", the bot walks them through products, quantities and address, then creates an order. Manage orders in the web app (statuses, CSV export, notify the customer in chat).
- **Sales analytics** (admin only): revenue, orders, average order value and chat→order conversion with comparison to the previous period (7 / 30 / 90 days), revenue-per-day chart (with table view), revenue by channel, top products, orders by status, and bot performance (conversations answered only by the bot, hand-offs). Cancelled orders are excluded from revenue.
- **Multi-user**: admin and agent roles, password login, rate-limited.
- **Mobile friendly**: installable as a phone app (PWA) via "Add to Home Screen".

## Run it (تشغيل)
Needs Node.js 20+.

```bash
npm install        # installs the WhatsApp QR support (optional, see below)
npm start          # http://localhost:3000
npm test           # unit + flow tests
```

Open the site, create the admin account, then **Settings → Products** (so the bot can take orders) and **Settings → Bot replies** (write your real prices, hours, address).

Data is stored in `./data` (change with `DATA_DIR`). Back this folder up; it contains chats, orders and WhatsApp session files. Never share it.

## Connect channels (Settings → Channels)
| Channel | How | Cost / notes |
|---|---|---|
| Telegram | Create a bot with @BotFather, paste the token | Free, official, works immediately (no public URL needed) |
| Messenger + Instagram | Meta developer app → paste Page token + App secret, set the callback URL and verify token shown in Settings | Free, official. Needs a public HTTPS URL and Meta App Review for real customers |
| WhatsApp (QR) | Settings → Connect with QR, scan from your phone | **Unofficial** (Baileys). Fine for testing; WhatsApp may restrict the number. Use a test number |
| WhatsApp (official) | WhatsApp Cloud API | Not included yet. Recommended before selling to brands |

## Deploy (النشر)
The server must run 24/7 and be reachable over HTTPS (needed by Meta webhooks).
- Any VPS / Render / Railway / Fly.io. A `Dockerfile` is included (mount a volume at `/data`).
- Put it behind HTTPS (Caddy, Nginx or the platform's proxy) and set `TRUST_PROXY=1`.
- Environment: `PORT`, `DATA_DIR`, `TRUST_PROXY=1`, `COOKIE_SECURE=1` (if TLS is terminated before the app).

## Security notes
- Passwords are hashed (scrypt), sessions are HttpOnly cookies, login attempts are rate-limited.
- Set the **App secret** for Meta so fake webhook calls are rejected.
- Channel tokens are stored in `data/db.json` in plain text. Protect the server and the volume.
- One deployment serves one brand. Selling to several brands = one deployment per brand (simplest), or add multi-tenancy later.

## Known limits
- JSON file storage: fine for a few thousand chats; move to SQLite/Postgres for bigger brands.
- Text only (media shows as `[Photo]` etc.). The bot answers text messages only.
- Instagram/Messenger can only be replied to within Meta's 24-hour messaging window.
