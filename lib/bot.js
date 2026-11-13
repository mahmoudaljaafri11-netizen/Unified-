// Rule-based auto-reply bot with a guided order flow. Pure logic: no I/O.

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function norm(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const hit = (list, t) => (list || []).some((k) => { const n = norm(k); return n && t.includes(n); });
const YES = /^(yes|y|ok|okay|confirm|sure|ايوه|اه|نعم|تمام|اكد|تاكيد|موافق)$/;
const CANCEL = /^(cancel|stop|الغاء|الغي|كنسل)$/;
const DONE = /^(done|thats all|that's all|finish|no|nope|تمام|خلاص|كفايه|لا|بس كده|كده)$/;
const GREETING = /^(hi|hello|hey|salam|good morning|good evening|سلام|السلام|مرحبا|اهلا|هاي|صباح|مساء)/;

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const totalOf = (items) => items.reduce((a, i) => a + i.price * i.qty, 0);

function productPrompt(s, intro = false) {
  const lines = s.catalog.map((p, i) => `${i + 1}. ${p.name} — ${s.currency} ${fmt(p.price)}`);
  return `${intro ? 'Great! What would you like to order? Reply with a number:\n\n' : ''}${lines.join('\n')}${intro ? '\n\n(Send "cancel" at any time to stop.)' : ''}`;
}

function pickProduct(catalog, t) {
  if (/^\d+$/.test(t)) return catalog[Number(t) - 1] || null;
  return catalog.find((p) => { const n = norm(p.name); return n && (t === n || t.includes(n)); }) || null;
}

function summary(s, st) {
  const lines = st.items.map((i) => `• ${i.qty} × ${i.name} — ${s.currency} ${fmt(i.price * i.qty)}`);
  return `Order summary:\n${lines.join('\n')}\nTotal: ${s.currency} ${fmt(totalOf(st.items))}\nDeliver to: ${st.address}\nPayment: ${s.paymentNote}\n\nReply "yes" to confirm or "cancel" to stop.`;
}

function orderStep(db, chat, t, raw, createOrder) {
  const s = db.settings;
  const st = chat.orderState;

  if (CANCEL.test(t) || (st.step === 'confirm' && /^(no|n|لا)$/.test(t))) {
    chat.orderState = null;
    return { reply: 'No problem, your order has been cancelled. Send "order" any time to start again.' };
  }
  if (hit(s.humanKeywords, t)) {
    chat.orderState = null;
    chat.needsAttention = true;
    chat.botPaused = true;
    return { reply: s.handoffReply, handoff: true };
  }

  switch (st.step) {
    case 'product':
    case 'more': {
      if (st.step === 'more' && DONE.test(t)) {
        st.step = 'address';
        return { reply: 'Great. Please send your full delivery address.' };
      }
      const item = pickProduct(s.catalog, t);
      if (!item) return { reply: `Please reply with a number from the list.\n\n${productPrompt(s)}` };
      st.current = item.id;
      st.step = 'qty';
      return { reply: `How many "${item.name}" would you like?` };
    }
    case 'qty': {
      const n = parseInt(t, 10);
      if (!(n >= 1 && n <= 99)) return { reply: 'Please send a quantity between 1 and 99.' };
      const p = s.catalog.find((c) => c.id === st.current);
      if (!p) { st.step = 'product'; return { reply: productPrompt(s) }; }
      const existing = st.items.find((i) => i.id === p.id);
      if (existing) existing.qty += n;
      else st.items.push({ id: p.id, name: p.name, price: p.price, qty: n });
      st.step = 'more';
      st.current = null;
      return { reply: `Added ${n} × ${p.name}. Send another product number to add more, or reply "done" to continue.` };
    }
    case 'address': {
      if (raw.trim().length < 6) return { reply: 'Please send your full delivery address.' };
      st.address = raw.trim().slice(0, 300);
      st.step = 'confirm';
      return { reply: summary(s, st) };
    }
    case 'confirm': {
      if (!YES.test(t)) return { reply: 'Reply "yes" to confirm your order, or "cancel" to stop.' };
      const order = createOrder({ items: st.items, address: st.address });
      chat.orderState = null;
      return { reply: `Thank you! Your order #${order.number} has been received. We'll confirm it shortly.`, order };
    }
    default:
      chat.orderState = null;
      return null;
  }
}

/**
 * Decide how to answer an incoming text message.
 * Mutates `chat` (orderState / needsAttention / botPaused). Returns { reply, handoff?, order? } or null.
 */
export function decide(db, chat, text, createOrder) {
  const s = db.settings;
  const t = norm(text);
  if (!t) return null;

  if (chat.orderState) return orderStep(db, chat, t, text, createOrder);

  if (hit(s.humanKeywords, t)) {
    chat.needsAttention = true;
    chat.botPaused = true;
    return { reply: s.handoffReply, handoff: true };
  }
  if (s.catalog.length && (t === 'order' || hit(s.orderKeywords, t))) {
    chat.orderState = { step: 'product', items: [], current: null, address: '' };
    return { reply: productPrompt(s, true) };
  }
  for (const r of s.rules) if (hit(r.keywords, t)) return { reply: r.reply };
  if (GREETING.test(t)) return { reply: s.greeting };

  chat.needsAttention = true;
  return { reply: s.fallback };
}
