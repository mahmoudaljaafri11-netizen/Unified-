import { db } from '../store.js';
import { receive, senders, broadcast } from '../core.js';

export const status = { state: 'off', username: '', error: '' };
let token = '';
let running = false;
let abort = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, body, signal) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram error ${res.status}`);
  return data.result;
}

async function send(chat, text) {
  await api('sendMessage', { chat_id: chat.externalId, text });
}

function label(msg) {
  if (msg.text) return { text: msg.text, isText: true };
  if (msg.caption) return { text: msg.caption, isText: false };
  if (msg.photo) return { text: '[Photo]', isText: false };
  if (msg.voice || msg.audio) return { text: '[Voice message]', isText: false };
  if (msg.document) return { text: '[File]', isText: false };
  if (msg.sticker) return { text: '[Sticker]', isText: false };
  if (msg.location) return { text: '[Location]', isText: false };
  return null;
}

async function loop() {
  let offset = 0;
  while (running) {
    abort = new AbortController();
    try {
      const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, abort.signal);
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || msg.chat?.type !== 'private' || msg.from?.is_bot) continue;
        const body = label(msg);
        if (!body) continue;
        const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || String(msg.chat.id);
        receive({ channel: 'telegram', externalId: String(msg.chat.id), name, text: body.text, isText: body.isText, msgId: String(msg.message_id) });
      }
    } catch (e) {
      if (!running) break;
      status.state = 'error';
      status.error = e.message;
      broadcast();
      await sleep(5000);
      if (running) { status.state = 'connected'; status.error = ''; }
    }
  }
}

export function stop() {
  running = false;
  abort?.abort();
  delete senders.telegram;
}

export async function start() {
  stop();
  token = db.channels.telegram.token;
  status.error = '';
  status.username = '';
  if (!token) { status.state = 'off'; broadcast(); return; }
  try {
    const me = await api('getMe');
    await api('deleteWebhook');
    status.state = 'connected';
    status.username = me.username || '';
  } catch (e) {
    status.state = 'error';
    status.error = e.message;
    broadcast();
    return;
  }
  running = true;
  senders.telegram = send;
  broadcast();
  loop();
}
