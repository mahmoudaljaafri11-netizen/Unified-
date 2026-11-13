import { db, save } from './store.js';
import { decide } from './bot.js';

/** channel name -> async (chat, text) => void */
export const senders = {};
export const sseClients = new Set();

export const CHANNEL_LABELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', telegram: 'Telegram', manual: 'Manual' };

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => 'm' + now().toString(36) + Math.random().toString(36).slice(2, 7);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function broadcast() {
  for (const res of sseClients) {
    try { res.write('event: update\ndata: {}\n\n'); } catch { /* client gone */ }
  }
}

function getChat(m) {
  const id = `${m.channel}:${m.externalId}`;
  let c = db.chats[id];
  if (!c) {
    c = db.chats[id] = {
      id, channel: m.channel, externalId: String(m.externalId), name: m.name || String(m.externalId).split('@')[0],
      messages: [], unread: 0, needsAttention: false, resolved: false, botPaused: false, pausedUntil: 0,
      orderState: null, tags: [], notes: '', createdAt: now(), last: now()
    };
  } else if (m.name && c.name === String(c.externalId).split('@')[0]) {
    c.name = m.name;
  }
  return c;
}

function push(c, msg) {
  c.messages.push({ id: rid(), ts: now(), ...msg });
  if (c.messages.length > 500) c.messages = c.messages.slice(-500);
  c.last = now();
}

const isPaused = (c) => c.botPaused || now() < c.pausedUntil;
export const chatBotPaused = isPaused;

export function createOrder({ chat, items, address, name, payment }) {
  db.seq.order += 1;
  const order = {
    id: 'o' + db.seq.order,
    number: db.seq.order,
    chatId: chat?.id || null,
    customer: chat?.name || name || 'Customer',
    channel: chat?.channel || 'manual',
    items,
    total: items.reduce((a, i) => a + i.price * i.qty, 0),
    currency: db.settings.currency,
    address: address || '',
    payment: payment || db.settings.paymentNote,
    status: 'new',
    createdAt: now(),
    timeline: [{ status: 'new', ts: now(), note: chat ? `Order placed in chat (${CHANNEL_LABELS[chat.channel] || chat.channel})` : 'Order created manually' }]
  };
  db.orders.unshift(order);
  if (db.orders.length > 5000) db.orders.length = 5000;
  return order;
}

// Serialise processing per chat so rapid messages don't race on order state.
const locks = new Map();
function enqueue(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => console.error('chat task failed:', e.message));
  locks.set(id, next);
  next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  return next;
}

/** Entry point for every inbound customer message from any channel. */
export function receive(m) {
  const c = getChat(m);
  if (m.msgId && c.messages.some((x) => x.ext === m.msgId)) return Promise.resolve();
  push(c, { dir: 'in', text: m.text, ext: m.msgId });
  c.unread += 1;
  if (c.resolved) c.resolved = false;
  save();
  broadcast();

  return enqueue(c.id, async () => {
    const s = db.settings;
    const send = senders[m.channel];
    if (!m.isText || !s.botEnabled || isPaused(c) || !send) return;

    const d = process.env.BOT_DELAY_MS;
    await sleep(d !== undefined ? Number(d) : 700 + Math.random() * 800);
    if (isPaused(c)) return; // agent took over while we waited

    const result = decide(db, c, m.text, (o) => createOrder({ chat: c, ...o }));
    if (!result) return;
    try {
      await send(c, result.reply);
      push(c, { dir: 'out', bot: true, text: result.reply });
    } catch (e) {
      console.error(`bot reply failed (${m.channel}):`, e.message);
      push(c, { dir: 'sys', kind: 'error', text: 'The automated reply could not be delivered.' });
    }
    if (result.handoff) push(c, { dir: 'sys', kind: 'handoff', text: 'Customer asked for a human. Bot paused on this chat.' });
    if (result.order) push(c, { dir: 'sys', kind: 'order', orderId: result.order.id, number: result.order.number, text: `New order #${result.order.number}` });
    save();
    broadcast();
  });
}

/** Agent reply from the web UI. */
export async function agentSend(chatId, text, user) {
  const c = db.chats[chatId];
  if (!c) throw new HttpError(404, 'Conversation not found');
  const send = senders[c.channel];
  if (!send) throw new HttpError(409, `${CHANNEL_LABELS[c.channel] || c.channel} is not connected`);
  try { await send(c, text); } catch (e) { throw new HttpError(502, `Could not send: ${e.message}`); }
  push(c, { dir: 'out', bot: false, by: user.name, text });
  c.pausedUntil = now() + db.settings.pauseMinutes * 60000;
  c.needsAttention = false;
  c.unread = 0;
  save();
  broadcast();
}

/** The business replied directly from their phone (WhatsApp). */
export function recordPhoneReply(channel, externalId, text, msgId) {
  const c = db.chats[`${channel}:${externalId}`];
  if (!c) return;
  if (msgId && c.messages.some((x) => x.ext === msgId)) return;
  push(c, { dir: 'out', bot: false, by: 'Phone', text, ext: msgId });
  c.pausedUntil = now() + db.settings.pauseMinutes * 60000;
  c.needsAttention = false;
  save();
  broadcast();
}

const STATUS_TEXT = {
  confirmed: (n) => `Good news! Your order #${n} has been confirmed.`,
  out_for_delivery: (n) => `Your order #${n} is out for delivery.`,
  delivered: (n) => `Your order #${n} has been delivered. Thank you!`,
  cancelled: (n) => `Your order #${n} has been cancelled. Reply here if you have any questions.`
};

export async function setOrderStatus(order, status, notify) {
  order.status = status;
  order.timeline.push({ status, ts: now(), note: '' });
  const c = order.chatId && db.chats[order.chatId];
  let notified = false;
  if (notify && c && STATUS_TEXT[status] && senders[c.channel]) {
    const text = STATUS_TEXT[status](order.number);
    try {
      await senders[c.channel](c, text);
      push(c, { dir: 'out', bot: true, text });
      notified = true;
    } catch (e) {
      push(c, { dir: 'sys', kind: 'error', text: 'The order update could not be delivered.' });
    }
  }
  save();
  broadcast();
  return notified;
}
