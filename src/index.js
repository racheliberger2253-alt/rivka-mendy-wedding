// אתר אישורי הגעה לחתונה — Cloudflare Worker + D1
// נתיבים:
//   /r/<token>#<details>  דף אישור ההגעה האישי של כל מוזמן
//   /vort, /gallery       העלאת תמונות מהאורחים והגלריה של המשפחה (ראו photos.js)
//   /admin                דף ניהול (מוגן במפתח ADMIN_KEY) עם כל התשובות וקוד סנכרון לדף ההתארגנות

import APP_HTML from './app.html';
import { photosRoute } from './photos.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{10,40}$/;
const SEG_RE = /^[A-Za-z0-9_.~:@+-]{1,120}$/;
const COLS = ['tasks','vendors','expenses','payments','guests','activity','prep','notes','planner'];
const EVENTS = ['ווארט', 'חתונה', 'שבת שבע ברכות'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      await ensureCore(env);
      if (path === '/') return html(HOME_PAGE);
      const ph = await photosRoute(request, env, path, url);
      if (ph) return ph;
      if (path === '/app') return html(APP_HTML);
      if (path === '/invite.jpg') return inviteImage(env);
      if (path === '/api/wa/status') return waStatus(request, env);
      if (path === '/api/wa/send' && request.method === 'POST') return waSend(request, env, url.origin);
      if (path.startsWith('/api/db')) return dbApi(request, env, path);
      if (path === '/admin') return html(ADMIN_PAGE);
      if (path === '/api/admin' && request.method === 'GET') return adminList(request, env);

      let m = path.match(/^\/r\/([^/]+)$/);
      if (m && request.method === 'GET') return TOKEN_RE.test(m[1]) ? guestPage(env, url.origin) : notFound();

      m = path.match(/^\/api\/r\/([^/]+)$/);
      if (m) {
        const token = m[1];
        if (!TOKEN_RE.test(token)) return json({ error: 'קישור לא תקין' }, 400);
        if (request.method === 'GET') return getResponse(env, token);
        if (request.method === 'POST') return saveResponse(request, env, token);
      }
      return notFound();
    } catch (err) {
      return json({ error: 'משהו השתבש. נסו שוב בעוד רגע.' }, 500);
    }
  },
};

// בפעם הראשונה: יוצר את הטבלאות ואת הגדרות ברירת המחדל (שם ותאריך)
let coreReady = false;
async function ensureCore(env) {
  if (coreReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS responses (token TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', answers TEXT NOT NULL DEFAULT '{}', count INTEGER NOT NULL DEFAULT 0, men INTEGER NOT NULL DEFAULT 0, women INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated_at)'),
    env.DB.prepare("INSERT OR IGNORE INTO docs (col, id, data, deleted, updated_at) VALUES ('planner', 'settings', ?, 0, ?)")
      .bind(JSON.stringify({ title: 'החתונה של רבקה ומענדי', date: '2026-12-29' }), Date.now()),
  ]);
  coreReady = true;
}

async function plannerDoc(env, col, id) {
  const r = await env.DB.prepare('SELECT data FROM docs WHERE col = ? AND id = ? AND deleted = 0').bind(col, id).first();
  return r ? safeParse(r.data) : null;
}
async function guestByToken(env, token) {
  return env.DB.prepare("SELECT id, data FROM docs WHERE col = 'guests' AND deleted = 0 AND json_extract(data, '$.rsvpToken') = ?").bind(token).first();
}
async function guestInfo(env, token) {
  const g = await guestByToken(env, token);
  if (!g) return null;
  const d = safeParse(g.data), s = (await plannerDoc(env, 'planner', 'settings')) || {};
  const evDate = e => e === 'חתונה' ? (s.date || '') : ((s.evDates || {})[e] || '');
  return { n: d.name || '', c: d.count || 1, e: [['חתונה', evDate('חתונה')]], t: s.title || 'החתונה שלנו',
    v: s.venue || '', ad: s.venueAddr || '', tr: s.tReception || '', tc: s.tChuppah || '', msg: s.guestMsg || '' };
}
async function getResponse(env, token) {
  const guest = await guestInfo(env, token).catch(() => null);
  const row = await env.DB.prepare('SELECT answers, count, men, women, note, updated_at FROM responses WHERE token = ?').bind(token).first();
  if (!row) return json({ found: false, guest });
  return json({ found: true, guest, a: safeParse(row.answers), m: row.men, w: row.women, c: row.count, note: row.note, at: row.updated_at });
}
async function inviteImage(env) {
  const d = await plannerDoc(env, 'planner', 'invite');
  const m = d && typeof d.img === 'string' && d.img.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) return new Response('', { status: 404 });
  const bin = atob(m[2]), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Response(u, { headers: { 'content-type': 'image/' + m[1], 'cache-control': 'public, max-age=300' } });
}
async function guestPage(env, origin) {
  const s = (await plannerDoc(env, 'planner', 'settings').catch(() => null)) || {};
  const inv = await plannerDoc(env, 'planner', 'invite').catch(() => null);
  const title = esc(s.title || 'החתונה שלנו');
  const og = `<meta property="og:title" content="${title}"><meta property="og:description" content="הזמנה לחתונה. נשמח שתאשרו הגעה"><meta property="og:type" content="website">` +
    (inv && inv.img ? `<meta property="og:image" content="${origin}/invite.jpg"><meta name="twitter:card" content="summary_large_image">` : '');
  const has = !!(inv && inv.img);
  return html(GUEST_PAGE.replace('<meta name="robots" content="noindex">', '<meta name="robots" content="noindex">' + og)
    .replace('<!--INVITE-->', has ? '<div class="wrap" style="padding:0"><img class="inv" src="/invite.jpg" alt="ההזמנה לחתונה"></div>' : '')
    .replace('INVCLS', has ? '' : 'top'));
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---- WhatsApp Business (Cloud API) automatic sending ---- */
async function familyOk(request, env) {
  const key = request.headers.get('x-family-key') || '';
  return !!env.FAMILY_KEY && (await sameText(key, env.FAMILY_KEY));
}
function waConfigured(env) { return !!(env.WA_TOKEN && env.WA_PHONE_ID && env.WA_TEMPLATE); }
async function waStatus(request, env) {
  if (!(await familyOk(request, env))) return json({ error: 'סיסמה שגויה' }, 401);
  return json({ configured: waConfigured(env) });
}
function intlPhone(ph) { let d = String(ph || '').replace(/\D/g, ''); if (!d) return ''; if (d.startsWith('00')) d = d.slice(2); if (d[0] === '0') d = '972' + d.slice(1); return d; }
async function waSend(request, env, origin) {
  if (!(await familyOk(request, env))) return json({ error: 'סיסמה שגויה' }, 401);
  if (!waConfigured(env)) return json({ error: 'השליחה האוטומטית עוד לא הוגדרה' }, 400);
  let body; try { body = await request.json(); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => SEG_RE.test(String(x))).slice(0, 100) : [];
  const inv = await plannerDoc(env, 'planner', 'invite');
  const results = [];
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT data FROM docs WHERE col = 'guests' AND id = ? AND deleted = 0").bind(id).first();
    if (!row) { results.push({ id, ok: false, error: 'לא נמצא' }); continue; }
    const g = safeParse(row.data), to = intlPhone(g.phone);
    if (!to || !g.rsvpToken) { results.push({ id, ok: false, error: 'אין טלפון' }); continue; }
    const components = [];
    if (inv && inv.img) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: origin + '/invite.jpg' } }] });
    components.push({ type: 'body', parameters: [{ type: 'text', text: (g.name || 'אורחים יקרים').slice(0, 60) }] });
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: g.rsvpToken }] });
    const r = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`, {
      method: 'POST', headers: { authorization: 'Bearer ' + env.WA_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: env.WA_TEMPLATE, language: { code: env.WA_LANG || 'he' }, components } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { results.push({ id, ok: false, error: (j.error && j.error.message) || 'השליחה נכשלה' }); continue; }
    const now = Date.now();
    g.invited = true; g.sentAt = now; g.sentVia = 'וואטסאפ אוטומטי'; g.sentCount = (Number(g.sentCount) || 0) + 1;
    await env.DB.prepare("UPDATE docs SET data = ?, updated_at = ? WHERE col = 'guests' AND id = ?").bind(JSON.stringify(g), now, id).run();
    results.push({ id, ok: true });
  }
  return json({ results });
}

async function saveResponse(request, env, token) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 4000) return json({ error: 'הבקשה גדולה מדי' }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
  const answers = {};
  for (const ev of EVENTS) {
    const v = body && body.a && body.a[ev];
    if (v === 'yes' || v === 'no') answers[ev] = v;
  }
  if (!Object.keys(answers).length) return json({ error: 'בחרו אם אתם מגיעים' }, 400);
  const men = Math.max(0, Math.min(30, Math.round(Number(body.m) || 0)));
  const women = Math.max(0, Math.min(30, Math.round(Number(body.w) || 0)));
  const anyYes = Object.values(answers).includes('yes');
  if (anyYes && men + women < 1) return json({ error: 'כמה תגיעו? בחרו לפחות משתתף אחד' }, 400);
  const count = anyYes ? men + women : 0;
  const note = String(body.note || '').slice(0, 300);
  const name = String(body.n || '').slice(0, 80);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO responses (token, name, answers, count, men, women, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET name = excluded.name, answers = excluded.answers, count = excluded.count, men = excluded.men, women = excluded.women, note = excluded.note, updated_at = excluded.updated_at`
  ).bind(token, name, JSON.stringify(answers), count, anyYes ? men : 0, anyYes ? women : 0, note, now).run();
  // עדכון המוזמן בדף ההתארגנות
  const g = await guestByToken(env, token);
  if (g) {
    const d = safeParse(g.data);
    const main = answers['חתונה'] ? 'חתונה' : Object.keys(answers)[0];
    d.rsvp = answers[main] === 'yes' ? 'מגיע' : 'לא מגיע';
    d.rsvpEv = answers; d.rsvpCount = count; d.rsvpMen = anyYes ? men : 0; d.rsvpWomen = anyYes ? women : 0; d.rsvpNote = note; d.rsvpAt = now; d.invited = true;
    await env.DB.prepare('UPDATE docs SET data = ?, updated_at = ? WHERE col = ? AND id = ?').bind(JSON.stringify(d), now, 'guests', g.id).run();
  }
  return json({ ok: true, at: now });
}

async function dbApi(request, env, path) {
  const key = request.headers.get('x-family-key') || '';
  if (!env.FAMILY_KEY || !(await sameText(key, env.FAMILY_KEY))) return json({ error: 'סיסמה שגויה' }, 401);
  const parts = path.split('/').slice(3); // after /api/db
  if (!parts.length && request.method === 'GET') {
    const since = Number(new URL(request.url).searchParams.get('since')) || 0;
    const { results } = await env.DB.prepare('SELECT col, id, data, deleted, updated_at FROM docs WHERE updated_at >= ? ORDER BY updated_at LIMIT 5000').bind(since).all();
    return json({ docs: results.map(r => ({ col: r.col, id: r.id, deleted: !!r.deleted, updated_at: r.updated_at, data: r.deleted ? null : safeParse(r.data) })) });
  }
  if (parts.length !== 2 || !COLS.includes(parts[0]) || !SEG_RE.test(parts[1])) return json({ error: 'נתיב לא תקין' }, 400);
  const [col, id] = parts;
  const now = Date.now();
  if (request.method === 'DELETE') {
    await env.DB.prepare(`INSERT INTO docs (col, id, data, deleted, updated_at) VALUES (?, ?, '{}', 1, ?)
      ON CONFLICT(col, id) DO UPDATE SET data = '{}', deleted = 1, updated_at = excluded.updated_at`).bind(col, id, now).run();
    return json({ ok: true, at: now });
  }
  if (request.method === 'PUT') {
    const raw = await request.text();
    if (raw.length > 200000) return json({ error: 'גדול מדי' }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
    if (!body || typeof body.data !== 'object' || Array.isArray(body.data)) return json({ error: 'בקשה לא תקינה' }, 400);
    let data = body.data;
    if (body.merge) {
      const cur = await env.DB.prepare('SELECT data, deleted FROM docs WHERE col = ? AND id = ?').bind(col, id).first();
      data = Object.assign({}, cur && !cur.deleted ? safeParse(cur.data) : {}, data);
    }
    await env.DB.prepare(`INSERT INTO docs (col, id, data, deleted, updated_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, deleted = 0, updated_at = excluded.updated_at`).bind(col, id, JSON.stringify(data), now).run();
    return json({ ok: true, at: now });
  }
  return json({ error: 'פעולה לא נתמכת' }, 405);
}

async function adminList(request, env) {
  const key = request.headers.get('x-admin-key') || '';
  const okAdmin = env.ADMIN_KEY && (await sameText(key, env.ADMIN_KEY));
  const okFamily = env.FAMILY_KEY && (await sameText(key, env.FAMILY_KEY));
  if (!okAdmin && !okFamily) return json({ error: 'סיסמה שגויה' }, 401);
  const { results } = await env.DB.prepare('SELECT token, name, answers, count, men, women, note, updated_at FROM responses ORDER BY updated_at DESC').all();
  return json({ rows: results.map(r => ({ k: r.token, n: r.name, a: safeParse(r.answers), c: r.count, m: r.men, w: r.women, note: r.note, at: r.updated_at })) });
}

async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function html(body) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}
function notFound() { return html(page('הדף לא נמצא', '<main class="card"><h1>הדף לא נמצא</h1><p class="muted">כדאי לבדוק שהקישור הועתק במלואו.</p></main>')); }

/* ---------------- pages ---------------- */
const STYLE = `
:root{--bg:#F7F7F5;--card:#fff;--ink:#1B1B19;--muted:#686760;--line:#E3E1DA;--tile:#F4F4F1;--yellow:#F1EA7A;
  --shadow:0 1px 2px rgba(27,27,25,.04),0 6px 20px rgba(27,27,25,.06)}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:'Heebo',system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:17px;line-height:1.5;min-height:100vh;
  padding:max(20px,env(safe-area-inset-top)) 16px 32px}
.card{max-width:520px;margin:0 auto;background:var(--card);border-radius:26px;box-shadow:var(--shadow);padding:28px 22px}
h1{font-family:'Heebo',sans-serif;font-weight:700;font-size:32px;line-height:1.15;margin:0 0 6px;text-wrap:balance}
.muted{color:var(--muted);margin:0}
.hi{font-size:20px;font-weight:600;margin:18px 0 4px}
.ev{background:var(--tile);border-radius:18px;padding:14px;margin-top:12px}
.ev h2{margin:0;font-size:18px}.ev .d{font-size:14px;color:var(--muted);margin:2px 0 10px}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.opt{min-height:50px;border-radius:14px;border:1.5px solid var(--line);background:#fff;font:inherit;font-weight:600;cursor:pointer;transition:background-color .2s,border-color .2s}
.opt[aria-pressed="true"]{background:var(--ink);color:#fff;border-color:var(--ink)}
.opt.no[aria-pressed="true"]{background:#fff;color:var(--ink);border-color:var(--ink)}
label.f{display:block;margin-top:16px;font-weight:600}
.step{display:flex;align-items:center;gap:10px;margin-top:8px}
.cnt2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}.cnt2>div{background:var(--tile);border-radius:16px;padding:10px 12px}.cnt2 span{font-weight:600}
p.f{margin:16px 0 0}
.invite{display:block;width:calc(100% + 44px);margin:-28px -22px 20px;border-radius:26px 26px 0 0;max-height:70vh;object-fit:cover}
.step button{width:48px;height:48px;border-radius:50%;border:1.5px solid var(--line);background:#fff;font-size:22px;cursor:pointer}
.step output{min-width:40px;text-align:center;font-size:22px;font-weight:600}
textarea,input{width:100%;font:inherit;border:1.5px solid var(--line);border-radius:14px;padding:12px;margin-top:8px;background:#fff}
textarea:focus,input:focus,button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.send{width:100%;min-height:54px;margin-top:20px;border:none;border-radius:999px;background:var(--yellow);font:inherit;font-weight:700;font-size:18px;cursor:pointer;color:var(--ink)}
.send:disabled{opacity:.5;cursor:default}
.err{color:#9B2C2C;font-weight:600;margin-top:12px;min-height:1em}
.done{text-align:center;padding:12px 0}
.done .big{width:72px;height:72px;border-radius:50%;background:var(--yellow);display:flex;align-items:center;justify-content:center;margin:6px auto 14px}
.link{background:none;border:none;color:var(--muted);text-decoration:underline;font:inherit;cursor:pointer;margin-top:12px;min-height:44px}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:right;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:13px}
.wide{max-width:960px}
.kp{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.kp div{background:var(--tile);border-radius:14px;padding:10px 14px}.kp b{display:block;font-size:26px;font-weight:400}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
function page(title, body, script = '') {
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800&display=swap">
<style>${STYLE}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const HOME_PAGE = page('אישורי הגעה', `<main class="card"><h1>אישורי הגעה</h1><p class="muted">כדי לאשר הגעה, פתחו את הקישור האישי שקיבלתם בהודעה.</p><p class="muted" style="margin-top:14px"><a href="/app" style="color:inherit">כניסה לדף ההתארגנות של המשפחה</a></p></main>`);

const GUEST_CSS = `
:root{--ink:#191917;--soft:#6E6C66;--line:#E7E5DF;--paper:#FFFFFF;--bg:#F5F4F1;--tile:#F7F6F3;--accent:#EDE48A}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:'Heebo',system-ui,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5;-webkit-font-smoothing:antialiased;padding:0 0 40px}
[hidden]{display:none!important}
button{font-family:inherit;color:inherit;-webkit-tap-highlight-color:transparent}
.wrap{max-width:480px;margin:0 auto;padding:0 14px}
.inv{display:block;width:100%;height:auto;border-radius:0 0 28px 28px;margin:0 auto}
.paper{background:var(--paper);border-radius:28px;box-shadow:0 1px 2px rgba(25,25,23,.04),0 10px 30px rgba(25,25,23,.06);padding:30px 22px;margin-top:-28px;position:relative}
.paper.top{margin-top:16px}
.kick{font-size:13px;letter-spacing:.08em;color:var(--soft);text-align:center;margin:0}
.names{font-size:34px;font-weight:300;letter-spacing:-.01em;text-align:center;margin:6px 0 4px;line-height:1.15;text-wrap:balance}
.date{text-align:center;margin:0;font-size:17px;font-weight:500}
.greg{text-align:center;margin:2px 0 0;color:var(--soft);font-size:15px}
.count{display:flex;justify-content:center;gap:8px;margin:22px 0 4px}
.count div{background:var(--tile);border-radius:16px;min-width:76px;padding:10px 8px;text-align:center}
.count b{display:block;font-size:30px;font-weight:300;line-height:1.05}
.count span{font-size:12px;color:var(--soft)}
.sep{height:1px;background:var(--line);margin:24px 0}
h2{font-size:15px;font-weight:600;margin:0 0 12px;color:var(--soft);letter-spacing:.02em}
.sched{display:flex;flex-direction:column;gap:0}
.slot{display:flex;align-items:center;gap:14px;padding:12px 0}
.slot+.slot{border-top:1px solid var(--line)}
.slot .t{font-size:24px;font-weight:300;min-width:76px;direction:ltr;text-align:right}
.slot .l{font-size:17px;font-weight:500}
.venue{background:var(--tile);border-radius:18px;padding:14px 16px}
.venue b{display:block;font-size:18px;font-weight:600}
.venue span{color:var(--soft);font-size:15px}
.nav{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.nav a{display:flex;align-items:center;justify-content:center;gap:6px;min-height:46px;border-radius:14px;background:#fff;border:1px solid var(--line);text-decoration:none;color:var(--ink);font-weight:500;font-size:15px}
.hi{font-size:20px;font-weight:500;margin:0 0 2px}
.sub{color:var(--soft);margin:0 0 16px;font-size:15px}
.opts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}
.opt{min-height:54px;border-radius:16px;border:1.5px solid var(--line);background:#fff;font-size:16px;font-weight:500;cursor:pointer;transition:background-color .2s,border-color .2s,color .2s}
.opt[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.opt.no[aria-pressed="true"]{background:#fff;color:var(--ink);border-color:var(--ink)}
.ppl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-top:14px}
.ppl>div{background:var(--tile);border-radius:16px;padding:12px;min-width:0}
.ppl .lab{font-size:15px;font-weight:500;display:block;margin-bottom:8px}
.step{display:flex;align-items:center;justify-content:space-between;gap:6px}
.step button{width:42px;height:42px;flex:none;border-radius:50%;border:1px solid var(--line);background:#fff;font-size:20px;line-height:1;cursor:pointer;color:var(--ink)}
.step button:disabled{opacity:.35;cursor:default}
.step output{font-size:24px;font-weight:300;min-width:28px;text-align:center}
label.f{display:block;margin:18px 0 6px;font-size:15px;font-weight:500}
label.f small{color:var(--soft);font-weight:400}
textarea{width:100%;font:inherit;font-size:16px;border:1px solid var(--line);border-radius:16px;padding:12px;background:#fff;resize:vertical;min-height:84px;color:var(--ink)}
textarea:focus,button:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.send{width:100%;min-height:56px;margin-top:18px;border:none;border-radius:999px;background:var(--ink);color:#fff;font-size:17px;font-weight:600;cursor:pointer;transition:opacity .2s}
.send:disabled{opacity:.25;cursor:default}
.err{color:#9B2C2C;font-weight:500;margin:10px 0 0;min-height:1em;text-align:center}
.done{text-align:center}
.done .ok{width:64px;height:64px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 12px}
.done h3{margin:0 0 4px;font-size:22px;font-weight:500}
.done p{margin:0;color:var(--soft)}
.link{background:none;border:none;color:var(--soft);text-decoration:underline;font-size:15px;cursor:pointer;margin-top:10px;min-height:44px}
.msg{text-align:center;color:var(--soft);margin:14px 0 0;font-size:15px;white-space:pre-line}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const GUEST_JS = `
(function(){
  var token=location.pathname.split('/').pop();
  var info={n:'',c:1,e:[['חתונה','']],t:'החתונה שלנו',v:'',ad:'',tr:'',tc:'',msg:''};
  try{var h=location.hash.slice(1);if(h){h=h.replace(/-/g,'+').replace(/_/g,'/');while(h.length%4)h+='=';var bin=atob(h),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);var d=JSON.parse(new TextDecoder().decode(u));if(d&&typeof d==='object')info=Object.assign(info,d);}}catch(e){}
  var st={a:null,m:0,w:0,note:''};
  var $=function(id){return document.getElementById(id);};
  function gem(n){var L=[[400,'ת'],[300,'ש'],[200,'ר'],[100,'ק'],[90,'צ'],[80,'פ'],[70,'ע'],[60,'ס'],[50,'נ'],[40,'מ'],[30,'ל'],[20,'כ'],[10,'י'],[9,'ט'],[8,'ח'],[7,'ז'],[6,'ו'],[5,'ה'],[4,'ד'],[3,'ג'],[2,'ב'],[1,'א']];var s='';n=n%1000;for(var i=0;i<L.length;i++){while(n>=L[i][0]){if(n===15){s+='טו';n=0;break;}if(n===16){s+='טז';n=0;break;}s+=L[i][1];n-=L[i][0];}}return s.length>1?s.slice(0,-1)+'״'+s.slice(-1):s+'׳';}
  function heb(dt){try{var p=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{day:'numeric',month:'long',year:'numeric'}).formatToParts(dt),d=0,m='',y=0;p.forEach(function(x){if(x.type==='day')d=+x.value;if(x.type==='month')m=x.value;if(x.type==='year')y=+x.value;});if(d&&m&&y)return gem(d)+' ב'+m+' '+gem(y);}catch(e){}return '';}
  function weddingDate(){var w=(info.e||[]).filter(function(x){return x[0]==='חתונה';})[0];return w&&w[1]?w[1]:'';}
  var timer=null;
  function paintHead(){
    document.title=info.t;$('names').textContent=info.t;
    var iso=weddingDate();
    if(iso){var dt=new Date(iso+'T00:00:00');var day=dt.toLocaleDateString('he-IL',{weekday:'long'});
      $('date').textContent=day+', '+heb(dt);$('greg').textContent=dt.toLocaleDateString('he-IL',{day:'numeric',month:'long',year:'numeric'});}
    tick();clearInterval(timer);timer=setInterval(tick,60000);
    // schedule
    var sc=$('sched');sc.innerHTML='';
    [[info.tr,'קבלת פנים'],[info.tc,'חופה וקידושין']].forEach(function(x){if(!x[0])return;var r=document.createElement('div');r.className='slot';
      var a=document.createElement('span');a.className='t';a.textContent=x[0];var b=document.createElement('span');b.className='l';b.textContent=x[1];r.appendChild(a);r.appendChild(b);sc.appendChild(r);});
    $('schedBox').hidden=!sc.children.length;
    // venue
    if(info.v||info.ad){$('venueBox').hidden=false;$('vn').textContent=info.v||'';$('va').textContent=info.ad||'';
      var q=encodeURIComponent((info.v?info.v+' ':'')+(info.ad||''));$('waze').href='https://waze.com/ul?q='+q+'&navigate=yes';$('gmaps').href='https://www.google.com/maps/search/?api=1&query='+q;}
    else $('venueBox').hidden=true;
    $('msg').textContent=info.msg||'';$('msg').hidden=!info.msg;
    $('hi').textContent=info.n?('שלום '+info.n):'שלום';
  }
  function tick(){var iso=weddingDate();if(!iso){$('count').hidden=true;return;}
    var target=new Date(iso+'T'+(/^\\d{1,2}:\\d{2}$/.test(info.tc||info.tr)?(info.tc||info.tr).padStart(5,'0'):'19:00')+':00');
    var ms=target-new Date();if(ms<=0){$('count').hidden=false;$('count').innerHTML='<div style="min-width:160px"><b>היום!</b><span>מחכים לכם</span></div>';return;}
    var d=Math.floor(ms/86400000),h=Math.floor(ms%86400000/3600000),m=Math.floor(ms%3600000/60000);
    $('count').hidden=false;$('cd').textContent=d;$('ch').textContent=h;$('cm').textContent=m;}
  function render(){
    ['yes','no'].forEach(function(v){$('o-'+v).setAttribute('aria-pressed',String(st.a===v));});
    $('ppl').hidden=st.a!=='yes';
    $('mNum').textContent=st.m;$('wNum').textContent=st.w;
    $('mMinus').disabled=st.m<=0;$('wMinus').disabled=st.w<=0;
    $('send').disabled=!st.a||(st.a==='yes'&&st.m+st.w<1);
  }
  $('o-yes').onclick=function(){st.a='yes';if(st.m+st.w===0){st.m=0;st.w=0;}render();};
  $('o-no').onclick=function(){st.a='no';render();};
  $('mMinus').onclick=function(){if(st.m>0){st.m--;render();}};
  $('mPlus').onclick=function(){if(st.m<30){st.m++;render();}};
  $('wMinus').onclick=function(){if(st.w>0){st.w--;render();}};
  $('wPlus').onclick=function(){if(st.w<30){st.w++;render();}};
  $('note').oninput=function(){st.note=this.value;};
  $('send').onclick=function(){
    var b=this;b.disabled=true;b.textContent='שולחים…';$('err').textContent='';
    fetch('/api/r/'+token,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({n:info.n,a:{'חתונה':st.a},m:st.a==='yes'?st.m:0,w:st.a==='yes'?st.w:0,note:st.note})})
      .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'');return j;});})
      .then(function(){b.textContent='אישור הגעה';showDone();})
      .catch(function(e){$('err').textContent=e.message||'השליחה לא הצליחה. בדקו את החיבור ונסו שוב.';b.disabled=false;b.textContent='אישור הגעה';});
  };
  function showDone(){$('form').hidden=true;$('done').hidden=false;
    var parts=[];if(st.m)parts.push(st.m===1?'גבר אחד':st.m+' גברים');if(st.w)parts.push(st.w===1?'אישה אחת':st.w+' נשים');
    $('doneT').textContent=st.a==='yes'?'מחכים לראות אתכם!':'תודה שעדכנתם';
    $('doneP').textContent=st.a==='yes'?'רשמנו '+parts.join(' ו'):'חבל שלא תוכלו להגיע. נשמח לשמוח איתכם בהזדמנות אחרת.';}
  $('edit').onclick=function(){$('done').hidden=true;$('form').hidden=false;render();};
  paintHead();render();
  fetch('/api/r/'+token).then(function(r){return r.json();}).then(function(j){
    if(j&&j.guest){info=Object.assign(info,j.guest);paintHead();}
    if(j&&j.found){var a=j.a&&(j.a['חתונה']||Object.keys(j.a).map(function(k){return j.a[k];})[0]);st.a=a||null;st.m=j.m||0;st.w=j.w||0;st.note=j.note||'';$('note').value=st.note;render();if(st.a)showDone();}
  }).catch(function(){});
})();`;

const GUEST_PAGE = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>הזמנה לחתונה</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700&display=swap">
<style>${GUEST_CSS}</style></head><body>
<!--INVITE-->
<div class="wrap">
  <section class="paper INVCLS">
    <p class="kick">בשמחה רבה אנו מזמינים אתכם לחתונה</p>
    <h1 class="names" id="names">החתונה שלנו</h1>
    <p class="date" id="date"></p>
    <p class="greg" id="greg"></p>
    <div class="count" id="count" hidden aria-label="ספירה לאחור">
      <div><b id="cd">0</b><span>ימים</span></div><div><b id="ch">0</b><span>שעות</span></div><div><b id="cm">0</b><span>דקות</span></div>
    </div>
    <p class="msg" id="msg" hidden></p>
    <div id="schedBox" hidden><div class="sep"></div><h2>סדר הערב</h2><div class="sched" id="sched"></div></div>
    <div id="venueBox" hidden><div class="sep"></div><h2>היכן</h2>
      <div class="venue"><b id="vn"></b><span id="va"></span>
        <div class="nav"><a id="waze" href="#" target="_blank" rel="noopener">ניווט ב-Waze</a><a id="gmaps" href="#" target="_blank" rel="noopener">Google Maps</a></div>
      </div>
    </div>
  </section>
  <section class="paper top">
    <div id="form">
      <p class="hi" id="hi">שלום</p>
      <p class="sub">נשמח לדעת אם תוכלו להגיע</p>
      <div class="opts" role="group" aria-label="האם תגיעו">
        <button class="opt" id="o-yes" type="button" aria-pressed="false">נגיע בשמחה</button>
        <button class="opt no" id="o-no" type="button" aria-pressed="false">לא נוכל להגיע</button>
      </div>
      <div id="ppl" class="ppl" hidden>
        <div><span class="lab">גברים</span><div class="step"><button type="button" id="mMinus" aria-label="פחות גברים">−</button><output id="mNum" aria-live="polite">0</output><button type="button" id="mPlus" aria-label="עוד גבר">+</button></div></div>
        <div><span class="lab">נשים</span><div class="step"><button type="button" id="wMinus" aria-label="פחות נשים">−</button><output id="wNum" aria-live="polite">0</output><button type="button" id="wPlus" aria-label="עוד אישה">+</button></div></div>
      </div>
      <label class="f" for="note">רוצים להוסיף משהו? <small>(לא חובה)</small></label>
      <textarea id="note" rows="3" maxlength="300" placeholder="ברכה, הגבלה תזונתית או כל דבר שחשוב שנדע"></textarea>
      <button class="send" id="send" type="button" disabled>אישור הגעה</button>
      <p class="err" id="err" role="alert"></p>
    </div>
    <div id="done" class="done" hidden>
      <div class="ok" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#191917" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h3 id="doneT"></h3><p id="doneP"></p>
      <button class="link" id="edit" type="button">לשינוי התשובה</button>
    </div>
  </section>
</div>
<script>${GUEST_JS}</script></body></html>`;

const ADMIN_JS = `
(function(){
  var $=function(id){return document.getElementById(id);};
  var key='';try{key=sessionStorage.getItem('rsvpKey')||'';}catch(e){}
  function b64u(s){var b=new TextEncoder().encode(s),bin='';b.forEach(function(x){bin+=String.fromCharCode(x);});return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
  function load(){
    $('msg').textContent='טוען…';
    fetch('/api/admin',{headers:{'x-admin-key':key}}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'');return j;});})
      .then(function(j){
        try{sessionStorage.setItem('rsvpKey',key);}catch(e){}
        $('login').hidden=true;$('data').hidden=false;$('msg').textContent='';
        var rows=j.rows||[],yes=0,no=0,people=0;
        var tb=$('tb');tb.innerHTML='';
        rows.forEach(function(r){var ay=Object.keys(r.a).some(function(k){return r.a[k]==='yes';});if(ay){yes++;people+=r.c||0;}else no++;
          var tr=document.createElement('tr');
          [r.n||'(ללא שם)',Object.keys(r.a).map(function(k){return k+': '+(r.a[k]==='yes'?'כן':'לא');}).join(', '),ay?(r.c+' ('+(r.m||0)+' גברים, '+(r.w||0)+' נשים)'):'—',r.note||'',new Date(r.at).toLocaleString('he-IL')].forEach(function(v){var td=document.createElement('td');td.textContent=v;tr.appendChild(td);});
          tb.appendChild(tr);});
        $('kYes').textContent=yes;$('kNo').textContent=no;$('kPeople').textContent=people;
        $('code').value=b64u(JSON.stringify(rows.map(function(r){return {k:r.k,a:r.a,c:r.c,m:r.m,w:r.w,note:r.note,at:r.at};})));
      })
      .catch(function(e){$('login').hidden=false;$('data').hidden=true;$('msg').textContent=e.message||'הטעינה לא הצליחה';});
  }
  $('go').onclick=function(){key=$('key').value.trim();if(key)load();};
  $('key').onkeydown=function(e){if(e.key==='Enter')$('go').click();};
  $('reload').onclick=load;
  $('copy').onclick=function(){var b=this;navigator.clipboard.writeText($('code').value).then(function(){b.textContent='הועתק! הדביקו בדף ההתארגנות';},function(){$('code').select();b.textContent='סמנו והעתיקו ידנית';});};
  if(key)load();
})();`;

const ADMIN_PAGE = page('ניהול אישורי הגעה', `
<main class="card wide">
  <h1>ניהול אישורי הגעה</h1>
  <div id="login">
    <label class="f" for="key">סיסמת המשפחה</label>
    <input id="key" type="password" autocomplete="current-password">
    <button class="send" id="go" type="button">כניסה</button>
  </div>
  <p class="err" id="msg" role="status"></p>
  <div id="data" hidden>
    <div class="kp"><div><span class="muted">אישרו</span><b id="kYes">0</b></div><div><span class="muted">לא מגיעים</span><b id="kNo">0</b></div><div><span class="muted">נפשות שאישרו</span><b id="kPeople">0</b></div></div>
    <label class="f" for="code">קוד סנכרון לדף ההתארגנות</label>
    <textarea id="code" rows="3" readonly style="direction:ltr;font-size:13px"></textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="send" id="copy" type="button" style="flex:1">העתקת קוד הסנכרון</button><button class="send" id="reload" type="button" style="flex:0 0 auto;background:var(--tile);padding:0 20px">רענון</button></div>
    <div style="overflow-x:auto;margin-top:18px"><table><thead><tr><th>שם</th><th>תשובה</th><th>נפשות</th><th>הערה</th><th>עודכן</th></tr></thead><tbody id="tb"></tbody></table></div>
  </div>
</main>`, ADMIN_JS);
