// העלאת תמונות וסרטונים מהאורחים — Cloudflare R2 (binding: PHOTOS) + D1 (binding: DB)
// נתיבים:
//   /vort                      דף ציבורי לאורחים: העלאת תמונות וסרטונים מהווארט
//   /gallery                   הגלריה הפרטית של המשפחה (סיסמת המשפחה, כמו ב-/app)
//   /api/photos/...            ה-API של שניהם
//
// להוספת אירוע חדש (למשל החתונה) מוסיפים שורה ל-EVENTS, וזה הכול.

import UPLOAD_HTML from './photos.html';
import GALLERY_HTML from './gallery.html';

export const EVENTS = {
  vort: { label: 'הווארט', title: 'התמונות שלכם מהווארט', kick: 'רבקה ומענדי · הווארט' },
};

const MAX_FILE = 4 * 1024 * 1024 * 1024; // 4GB לקובץ
const SINGLE_MAX = 90 * 1024 * 1024;     // מעל זה מעלים בחלקים
const PART = 20 * 1024 * 1024;           // גודל כל חלק
const THUMB_MAX = 600 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const LINK_HOURS = 12;

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, r2key TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, uploader TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', upload_id TEXT, thumb INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS photos_ev ON photos(event, status, created_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photo_events (slug TEXT PRIMARY KEY, open INTEGER NOT NULL DEFAULT 1)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photo_shares (token TEXT PRIMARY KEY, slug TEXT NOT NULL, created_at INTEGER NOT NULL)'),
  ]);
  schemaReady = true;
}

export async function photosRoute(request, env, path, url) {
  const slug = path.slice(1);
  if (request.method === 'GET' && EVENTS[slug]) return uploadPage(slug);
  if (path === '/gallery') return galleryPage(null);
  const am = path.match(/^\/album\/([A-Za-z0-9_-]{16,40})$/);
  if (am && request.method === 'GET') return galleryPage(am[1]);
  if (!path.startsWith('/api/photos/')) return null;

  if (!env.PHOTOS) return json({ error: 'אחסון התמונות עוד לא חובר לאתר (R2)' }, 503);
  await ensureSchema(env);
  const parts = path.split('/').slice(3); // after /api/photos
  const [action, id] = parts;
  const m = request.method;

  // ---- ציבורי (אורחים) ----
  if (action === 'info' && m === 'GET' && EVENTS[id]) return eventInfo(env, id);
  if (action === 'start' && m === 'POST') return startUpload(request, env);
  if (action === 'up' && m === 'PUT') return withTicket(request, env, url, id, row => putSingle(request, env, row));
  if (action === 'part' && m === 'PUT') return withTicket(request, env, url, id, row => putPart(request, env, url, row));
  if (action === 'done' && m === 'POST') return withTicket(request, env, url, id, row => finishMulti(request, env, row));
  if (action === 'thumb' && m === 'PUT') return withTicket(request, env, url, id, row => putThumb(request, env, row));
  if (action === 'f' && m === 'GET') return serveFile(request, env, url, id);
  if (action === 'album' && m === 'GET') return albumList(env, id);

  // ---- משפחה בלבד ----
  if (!(await familyOk(request, env))) return json({ error: 'סיסמה שגויה' }, 401);
  if (action === 'list' && m === 'GET') return listPhotos(env, url);
  if (action === 'item' && m === 'DELETE') return deletePhoto(env, id);
  if (action === 'open' && m === 'POST') return setOpen(request, env);
  if (action === 'share' && m === 'POST') return shareLink(request, env);
  return json({ error: 'נתיב לא תקין' }, 404);
}

function uploadPage(slug) {
  const ev = EVENTS[slug];
  return html(UPLOAD_HTML
    .replaceAll('{{TITLE}}', esc(ev.title))
    .replaceAll('{{KICK}}', esc(ev.kick))
    .replace('{{SLUG}}', slug));
}

async function isOpen(env, slug) {
  const r = await env.DB.prepare('SELECT open FROM photo_events WHERE slug = ?').bind(slug).first();
  return r ? !!r.open : true;
}
async function eventInfo(env, slug) {
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE event = ? AND status = 'done'").bind(slug).first();
  return json({ open: await isOpen(env, slug), count: c ? c.n : 0 });
}

async function startUpload(request, env) {
  if (!env.FAMILY_KEY) return json({ error: 'האתר לא מוגדר' }, 500);
  let b; try { b = await request.json(); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
  const ev = String(b.ev || '');
  if (!EVENTS[ev]) return json({ error: 'אירוע לא קיים' }, 400);
  if (!(await isOpen(env, ev))) return json({ error: 'ההעלאה לאירוע הזה נסגרה', closed: true }, 403);
  const type = String(b.type || '').toLowerCase().slice(0, 80);
  const name = String(b.name || 'file').slice(0, 160);
  const size = Math.round(Number(b.size) || 0);
  if (!/^(image|video)\//.test(type) && !/\.(heic|heif|jpe?g|png|webp|gif|mp4|mov|m4v|3gp|webm)$/i.test(name))
    return json({ error: 'אפשר להעלות רק תמונות וסרטונים' }, 400);
  if (size < 1) return json({ error: 'הקובץ ריק' }, 400);
  if (size > MAX_FILE) return json({ error: 'הקובץ גדול מדי' }, 413);
  const id = randomId();
  const ext = ((name.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || (type.split('/')[1] || 'bin')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ev}/${day}/${id}.${ext}`;
  const ctype = type || 'application/octet-stream';
  let uploadId = null;
  const multi = size > SINGLE_MAX;
  if (multi) {
    const mpu = await env.PHOTOS.createMultipartUpload(key, { httpMetadata: { contentType: ctype } });
    uploadId = mpu.uploadId;
  }
  await env.DB.prepare(`INSERT INTO photos (id, event, r2key, name, type, size, uploader, note, upload_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, ev, key, name, ctype, size, String(b.by || '').slice(0, 60), String(b.note || '').slice(0, 300), uploadId, Date.now()).run();
  return json({ id, t: await sign(env, 'up:' + id), multi, part: PART });
}

async function withTicket(request, env, url, id, fn) {
  if (!ID_RE.test(id || '')) return json({ error: 'לא תקין' }, 400);
  const t = url.searchParams.get('t') || '';
  if (!(await sameText(t, await sign(env, 'up:' + id)))) return json({ error: 'אין הרשאה' }, 403);
  const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'לא נמצא' }, 404);
  return fn(row);
}

async function putSingle(request, env, row) {
  if (row.upload_id) return json({ error: 'לא תקין' }, 400);
  if (row.status === 'done') return json({ ok: true });
  const obj = await env.PHOTOS.put(row.r2key, request.body, { httpMetadata: { contentType: row.type } });
  await env.DB.prepare("UPDATE photos SET status = 'done', size = ? WHERE id = ?").bind(obj ? obj.size : row.size, row.id).run();
  return json({ ok: true });
}

async function putPart(request, env, url, row) {
  if (!row.upload_id || row.status === 'done') return json({ error: 'לא תקין' }, 400);
  const n = Math.round(Number(url.searchParams.get('n')) || 0);
  if (n < 1 || n > 10000) return json({ error: 'לא תקין' }, 400);
  const mpu = env.PHOTOS.resumeMultipartUpload(row.r2key, row.upload_id);
  const part = await mpu.uploadPart(n, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function finishMulti(request, env, row) {
  if (!row.upload_id) return json({ error: 'לא תקין' }, 400);
  if (row.status === 'done') return json({ ok: true });
  let b; try { b = await request.json(); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
  const list = (Array.isArray(b.parts) ? b.parts : [])
    .map(p => ({ partNumber: Math.round(Number(p.partNumber)), etag: String(p.etag || '') }))
    .filter(p => p.partNumber > 0 && p.etag)
    .sort((a, c) => a.partNumber - c.partNumber);
  if (!list.length) return json({ error: 'לא תקין' }, 400);
  const mpu = env.PHOTOS.resumeMultipartUpload(row.r2key, row.upload_id);
  const obj = await mpu.complete(list);
  await env.DB.prepare("UPDATE photos SET status = 'done', size = ? WHERE id = ?").bind(obj ? obj.size : row.size, row.id).run();
  return json({ ok: true });
}

async function putThumb(request, env, row) {
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > THUMB_MAX) return json({ error: 'גדול מדי' }, 413);
  await env.PHOTOS.put('thumbs/' + row.id + '.jpg', request.body, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE photos SET thumb = 1 WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
}

async function serveFile(request, env, url, id) {
  if (!ID_RE.test(id || '')) return new Response('', { status: 404 });
  const e = Number(url.searchParams.get('e')) || 0, s = url.searchParams.get('s') || '';
  if (e < Date.now() || !(await sameText(s, await sign(env, 'f:' + id + ':' + e)))) return new Response('הקישור פג תוקף', { status: 403 });
  const row = await env.DB.prepare("SELECT * FROM photos WHERE id = ? AND status = 'done'").bind(id).first();
  if (!row) return new Response('', { status: 404 });
  const thumb = url.searchParams.get('thumb') === '1' && row.thumb;
  const key = thumb ? 'thumbs/' + id + '.jpg' : row.r2key;
  const obj = await env.PHOTOS.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'private, max-age=3600');
  if (url.searchParams.get('dl') === '1') h.set('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(row.name || id));
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers: h });
  if (obj.range && request.headers.has('range')) {
    const r = obj.range, start = r.offset ?? (obj.size - r.suffix), len = r.length ?? (obj.size - start);
    h.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}

function galleryPage(share) {
  return html(GALLERY_HTML.replace('/*EVENTS*/{}', JSON.stringify(EVENTS)).replace('/*SHARE*/null', JSON.stringify(share)));
}
async function listPhotos(env, url) {
  const ev = url.searchParams.get('ev') || 'vort';
  return json({ items: await itemsFor(env, ev), open: await isOpen(env, ev) });
}
async function albumList(env, token) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token || '')) return json({ error: 'הקישור לא תקין' }, 404);
  const r = await env.DB.prepare('SELECT slug FROM photo_shares WHERE token = ?').bind(token).first();
  if (!r || !EVENTS[r.slug]) return json({ error: 'הקישור הזה כבר לא פעיל' }, 404);
  return json({ ev: r.slug, items: await itemsFor(env, r.slug) });
}
async function shareLink(request, env) {
  let b; try { b = await request.json(); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
  if (!EVENTS[b.ev]) return json({ error: 'אירוע לא קיים' }, 400);
  if (b.reset) await env.DB.prepare('DELETE FROM photo_shares WHERE slug = ?').bind(b.ev).run();
  let r = await env.DB.prepare('SELECT token FROM photo_shares WHERE slug = ?').bind(b.ev).first();
  if (!r) {
    r = { token: randomId() + randomId().slice(0, 4) };
    await env.DB.prepare('INSERT INTO photo_shares (token, slug, created_at) VALUES (?, ?, ?)').bind(r.token, b.ev, Date.now()).run();
  }
  return json({ token: r.token });
}
async function itemsFor(env, ev) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, size, uploader, note, thumb, created_at FROM photos WHERE event = ? AND status = 'done' ORDER BY created_at DESC LIMIT 5000"
  ).bind(ev).all();
  const exp = Date.now() + LINK_HOURS * 3600 * 1000;
  const items = await Promise.all(results.map(async r => {
    const q = `/api/photos/f/${r.id}?e=${exp}&s=${await sign(env, 'f:' + r.id + ':' + exp)}`;
    return { id: r.id, name: r.name, type: r.type, size: r.size, by: r.uploader, note: r.note, at: r.created_at,
      url: q, thumb: r.thumb ? q + '&thumb=1' : null, dl: q + '&dl=1' };
  }));
  return items;
}

async function deletePhoto(env, id) {
  if (!ID_RE.test(id || '')) return json({ error: 'לא תקין' }, 400);
  const row = await env.DB.prepare('SELECT r2key FROM photos WHERE id = ?').bind(id).first();
  if (row) await env.PHOTOS.delete([row.r2key, 'thumbs/' + id + '.jpg']);
  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function setOpen(request, env) {
  let b; try { b = await request.json(); } catch { return json({ error: 'בקשה לא תקינה' }, 400); }
  if (!EVENTS[b.ev]) return json({ error: 'אירוע לא קיים' }, 400);
  await env.DB.prepare('INSERT INTO photo_events (slug, open) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET open = excluded.open')
    .bind(b.ev, b.open ? 1 : 0).run();
  return json({ ok: true, open: !!b.open });
}

/* ---- helpers ---- */
async function familyOk(request, env) {
  const key = request.headers.get('x-family-key') || '';
  return !!env.FAMILY_KEY && (await sameText(key, env.FAMILY_KEY));
}
let hmacKey = null;
async function sign(env, msg) {
  if (!hmacKey) hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('photos:' + env.FAMILY_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(msg)));
  return b64url(sig.slice(0, 18));
}
function randomId() { return b64url(crypto.getRandomValues(new Uint8Array(15))); }
function b64url(u) { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function html(body) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}
