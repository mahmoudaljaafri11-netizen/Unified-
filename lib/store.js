import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaults = () => ({
  users: [],
  sessions: {},
  seq: { order: 1000 },
  settings: {
    brandName: 'My Brand',
    accent: '#4338CA',
    currency: 'EGP',
    paymentNote: 'Cash on delivery',
    botEnabled: true,
    pauseMinutes: 30,
    greeting: 'Hi there! How can we help you today?',
    fallback: 'Thanks for your message. A team member will reply shortly.',
    handoffReply: 'Sure, a team member will take over in a moment.',
    orderKeywords: ['i want to order', 'want to order', 'place an order', 'new order', 'order now', 'buy', 'عايز اطلب', 'عاوز اطلب', 'اطلب', 'اوردر جديد'],
    humanKeywords: ['human', 'agent', 'call me', 'real person', 'موظف', 'كلمني', 'حد يكلمني'],
    rules: [
      { id: 'r1', keywords: ['price', 'prices', 'cost', 'سعر', 'اسعار', 'بكام'], reply: 'Prices: [add your prices here]' },
      { id: 'r2', keywords: ['hours', 'open', 'opening', 'مواعيد', 'ميعاد', 'فاتحين'], reply: 'Working hours: [add your hours here]' },
      { id: 'r3', keywords: ['delivery', 'shipping', 'توصيل', 'شحن'], reply: 'Delivery: [add delivery details here]' },
      { id: 'r4', keywords: ['address', 'location', 'where are you', 'عنوان', 'فين', 'لوكيشن'], reply: 'Address: [add your address here]' }
    ],
    catalog: []
  },
  channels: {
    telegram: { token: '' },
    meta: { pageToken: '', verifyToken: crypto.randomBytes(12).toString('hex'), appSecret: '' }
  },
  chats: {},
  orders: []
});

function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      ...base,
      ...saved,
      settings: { ...base.settings, ...saved.settings },
      seq: { ...base.seq, ...saved.seq },
      channels: {
        telegram: { ...base.channels.telegram, ...saved.channels?.telegram },
        meta: { ...base.channels.meta, ...saved.channels?.meta }
      }
    };
  } catch {
    return base;
  }
}

export const db = load();

let timer = null;
export function flush() {
  clearTimeout(timer);
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}
