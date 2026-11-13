// Facebook Messenger + Instagram DMs through the official Meta Graph API (webhooks).
import crypto from 'node:crypto';
import { db } from '../store.js';
import { receive, senders } from '../core.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

async function graph(path, init = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${db.channels.meta.pageToken}`, 'content-type': 'application/json', ...init.headers }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Graph API error ${res.status}`);
  return data;
}

async function send(chat, text) {
  await graph('/me/messages', {
    method: 'POST',
    body: JSON.stringify({ recipient: { id: chat.externalId }, messaging_type: 'RESPONSE', message: { text } })
  });
}

export function configure() {
  if (db.channels.meta.pageToken) {
    senders.messenger = send;
    senders.instagram = send;
  } else {
    delete senders.messenger;
    delete senders.instagram;
  }
}

/** GET handshake. Returns the challenge string or null. */
export function verify(query) {
  const m = db.channels.meta;
  if (query.get('hub.mode') === 'subscribe' && m.verifyToken && query.get('hub.verify_token') === m.verifyToken) {
    return query.get('hub.challenge') || '';
  }
  return null;
}

function signatureOk(raw, header) {
  const secret = db.channels.meta.appSecret;
  if (!secret) return true; // not enforced until an app secret is configured
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function lookupName(id) {
  try {
    const p = await graph(`/${encodeURIComponent(id)}?fields=name,username`);
    return p.name || p.username || null;
  } catch { return null; }
}

/** POST webhook. Returns false when the signature is invalid. */
export function handle(raw, signature) {
  if (!signatureOk(raw, signature)) return false;
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return true; }
  const channel = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'messenger' : null;
  if (!channel) return true;

  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || msg.is_echo || !ev.sender?.id) continue;
      const text = msg.text || (msg.attachments?.length ? `[${msg.attachments[0].type || 'Attachment'}]` : '');
      if (!text) continue;
      const id = String(ev.sender.id);
      const known = db.chats[`${channel}:${id}`];
      (async () => {
        const name = known ? undefined : (db.channels.meta.pageToken ? await lookupName(id) : null);
        receive({ channel, externalId: id, name: name || undefined, text, isText: !!msg.text, msgId: msg.mid });
      })().catch((e) => console.error('meta webhook:', e.message));
    }
  }
  return true;
}
