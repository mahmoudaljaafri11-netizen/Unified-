// Sales analytics computed from orders and chats. Pure function: easy to test.
const DAY = 86400000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function computeAnalytics(db, { days = 30, tzOffsetMin = 0, now = Date.now() } = {}) {
  days = clamp(Math.round(Number(days)) || 30, 1, 365);
  const off = clamp(Math.round(Number(tzOffsetMin)) || 0, -840, 840); // Date#getTimezoneOffset(): UTC minus local
  const localDay = (ts) => Math.floor((ts - off * 60000) / DAY) * DAY + off * 60000; // local midnight as a UTC instant
  const end = localDay(now) + DAY; // exclusive
  const start = end - days * DAY;
  const prevStart = start - days * DAY;
  const isoDay = (ts) => new Date(ts - off * 60000).toISOString().slice(0, 10);

  const orders = db.orders || [];
  const chats = Object.values(db.chats || {});
  const inRange = (ts, a, b) => ts >= a && ts < b;
  const valid = (o) => o.status !== 'cancelled';

  function period(from, to) {
    const all = orders.filter((o) => inRange(o.createdAt, from, to));
    const ok = all.filter(valid);
    const revenue = ok.reduce((a, o) => a + o.total, 0);
    const active = new Set();
    for (const c of chats) if (c.messages.some((m) => m.dir === 'in' && inRange(m.ts, from, to))) active.add(c.id);
    const converted = new Set(ok.filter((o) => o.chatId && active.has(o.chatId)).map((o) => o.chatId));
    return {
      all, ok, revenue, orders: ok.length, cancelled: all.length - ok.length,
      aov: ok.length ? revenue / ok.length : 0,
      activeChats: active.size, active, converted: converted.size,
      conversion: active.size ? (converted.size / active.size) * 100 : 0
    };
  }

  const cur = period(start, end);
  const prev = period(prevStart, start);

  const daily = [];
  const byDay = new Map();
  for (const o of cur.ok) {
    const k = isoDay(o.createdAt);
    const d = byDay.get(k) || { revenue: 0, orders: 0 };
    d.revenue += o.total; d.orders += 1;
    byDay.set(k, d);
  }
  for (let i = 0; i < days; i++) {
    const k = isoDay(start + i * DAY + 1);
    const d = byDay.get(k) || { revenue: 0, orders: 0 };
    daily.push({ date: k, revenue: d.revenue, orders: d.orders });
  }

  const group = (keyFn) => {
    const m = new Map();
    for (const o of cur.ok) for (const [k, add] of keyFn(o)) {
      const r = m.get(k) || { key: k, revenue: 0, orders: 0, qty: 0 };
      r.revenue += add.revenue || 0; r.orders += add.orders || 0; r.qty += add.qty || 0;
      m.set(k, r);
    }
    return [...m.values()];
  };
  const byChannel = group((o) => [[o.channel, { revenue: o.total, orders: 1 }]]).sort((a, b) => b.revenue - a.revenue);
  const topProducts = group((o) => o.items.map((i) => [i.name, { revenue: i.price * i.qty, qty: i.qty }]))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 8)
    .map((r) => ({ name: r.key, revenue: r.revenue, qty: r.qty }));

  const status = {};
  for (const o of cur.all) status[o.status] = (status[o.status] || 0) + 1;

  let botReplies = 0, handoffs = 0, autoHandled = 0;
  for (const c of chats) {
    if (!cur.active.has(c.id)) continue;
    let bot = 0, human = 0;
    for (const m of c.messages) {
      if (!inRange(m.ts, start, end)) continue;
      if (m.dir === 'out' && m.bot) bot++;
      else if (m.dir === 'out') human++;
      else if (m.dir === 'sys' && m.kind === 'handoff') handoffs++;
    }
    botReplies += bot;
    if (bot > 0 && human === 0) autoHandled++;
  }

  const strip = (p) => ({ revenue: p.revenue, orders: p.orders, cancelled: p.cancelled, aov: p.aov, conversion: p.conversion, activeChats: p.activeChats });
  return {
    days, start, end, currency: db.settings?.currency || '',
    current: strip(cur), previous: strip(prev),
    daily, byChannel, topProducts, status,
    bot: { conversations: cur.activeChats, autoHandled, handoffs, botReplies, ordersFromChat: cur.ok.filter((o) => o.chatId).length, convertedChats: cur.converted }
  };
}
