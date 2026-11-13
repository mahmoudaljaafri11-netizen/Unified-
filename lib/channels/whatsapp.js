// WhatsApp through Baileys (linked-device / QR). UNOFFICIAL: use for testing only.
// For production brands use the official WhatsApp Cloud API instead.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.js';
import { receive, recordPhoneReply, senders, broadcast } from '../core.js';

const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const status = { state: 'off', qr: null, phone: '', error: '' };
let lib = null;
let sock = null;
let wanted = false;
let timer = null;
const botSent = new Set();

export const getStatus = () => ({ ...status });

async function loadLib() {
  if (lib) return lib;
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const qr = await import('qrcode');
    const pino = (await import('pino')).default;
    lib = { baileys, qr: qr.default ?? qr, pino };
    return lib;
  } catch {
    status.state = 'error';
    status.error = 'WhatsApp support is not installed. Run "npm install" on the server.';
    throw new Error(status.error);
  }
}

async function send(chat, text) {
  if (!sock || status.state !== 'connected') throw new Error('WhatsApp is not connected');
  const res = await sock.sendMessage(chat.externalId, { text });
  botSent.add(res.key.id);
  if (botSent.size > 500) botSent.delete(botSent.values().next().value);
}

export async function connect() {
  clearTimeout(timer);
  wanted = true;
  if (sock && ['connecting', 'qr', 'connected'].includes(status.state)) return;
  let L;
  try { L = await loadLib(); } catch { broadcast(); return; }

  const b = L.baileys;
  const makeWASocket = b.default?.default ?? b.default ?? b.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = b;

  status.state = 'connecting';
  status.error = '';
  broadcast();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  const s = makeWASocket({ auth: state, version, logger: L.pino({ level: 'silent' }), browser: ['Unified Inbox', 'Chrome', '1.0'] });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return;
    if (qr) {
      status.state = 'qr';
      status.qr = await L.qr.toDataURL(qr, { width: 280, margin: 1 });
      broadcast();
    }
    if (connection === 'open') {
      status.state = 'connected';
      status.qr = null;
      status.phone = (s.user?.id || '').split(':')[0].split('@')[0];
      senders.whatsapp = send;
      broadcast();
    }
    if (connection === 'close') {
      sock = null;
      delete senders.whatsapp;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        status.state = 'off';
        status.qr = null;
        status.phone = '';
        wanted = false;
      } else if (wanted) {
        status.state = 'connecting';
        timer = setTimeout(() => connect().catch(() => {}), 3000);
      }
      broadcast();
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) {
      try {
        if (!m.message) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || '';
        const media = m.message.imageMessage ? '[Photo]' : m.message.audioMessage ? '[Voice message]' : m.message.documentMessage ? '[File]' : m.message.videoMessage ? '[Video]' : m.message.stickerMessage ? '[Sticker]' : '';
        const body = text || media;
        if (!body) continue;
        const id = m.key.id;
        if (m.key.fromMe) {
          if (!botSent.has(id)) recordPhoneReply('whatsapp', jid, body, id);
          continue;
        }
        if (type !== 'notify') continue;
        receive({ channel: 'whatsapp', externalId: jid, name: m.pushName, text: body, isText: !!m.message.conversation || !!m.message.extendedTextMessage, msgId: id });
      } catch (e) {
        console.error('whatsapp message error:', e.message);
      }
    }
  });
}

export async function disconnect() {
  wanted = false;
  clearTimeout(timer);
  try { await sock?.logout(); } catch { /* already closed */ }
  sock = null;
  delete senders.whatsapp;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  status.state = 'off';
  status.qr = null;
  status.phone = '';
  status.error = '';
  broadcast();
}

export function autoStart() {
  if (fs.existsSync(AUTH_DIR)) connect().catch(() => {});
}
