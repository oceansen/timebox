// Timebox server: serves the page, keeps projects and the live timer state,
// and pushes every change to open screens over Server-Sent Events.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PIN = (process.env.CONTROL_PIN || '').trim();
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'timebox.json');
const PAGE = path.join(__dirname, 'public', 'index.html');

/* ---------------- state ---------------- */
const projects = new Map();     // id -> project body
let liveId = null;

const SEED = [{
  id: 'psct-impact', name: 'SCT Impact Workshop', status: 'idle', elapsed: 0, anchor: 0, createdAt: 1791961000000,
  activities: [
    { id: 's1', name: 'Story Owner introduces the research and impact', min: 10, color: '#24487f' },
    { id: 's2', name: 'Assign thinking roles · prepare the A3 canvas', min: 5, color: '#3f9aaa' },
    { id: 's3', name: 'Explore the five canvas areas', min: 50, color: '#24487f' },
    { id: 's4', name: 'Agree message, evidence and visual per slide', min: 15, color: '#3f9aaa' },
    { id: 's5', name: 'Story Owner pitches the revised story', min: 5, color: '#24487f' },
    { id: 's6', name: 'Photograph the canvas · record gaps and next steps', min: 5, color: '#3f9aaa' },
  ],
}];

/* ---------------- storage: Postgres when DATABASE_URL is set, else a JSON file ---------------- */
let pool = null;
async function storeInit() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const external = /render\.com|amazonaws|sslmode=require/.test(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL, ssl: external ? { rejectUnauthorized: false } : false, max: 4 });
    await pool.query('CREATE TABLE IF NOT EXISTS timebox_docs (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await pool.query('SELECT key, data FROM timebox_docs');
    for (const r of rows) {
      if (r.key === 'live') liveId = r.data.projectId || null;
      else if (r.key.startsWith('project:')) projects.set(r.key.slice(8), r.data);
    }
    console.log(`storage: postgres (${projects.size} projects)`);
  } else {
    try {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      (d.projects || []).forEach(p => projects.set(p.id, p));
      liveId = d.liveId || null;
    } catch (e) { /* first run */ }
    console.log(`storage: file ${DATA_FILE} (${projects.size} projects) — set DATABASE_URL to keep data across restarts`);
  }
  if (!projects.size) for (const p of SEED) { projects.set(p.id, { ...p }); await persistProject(p.id); }
}
let fileTimer = null;
function writeFileSoon() {
  clearTimeout(fileTimer);
  fileTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ projects: [...projects.values()], liveId }));
    } catch (e) { console.error('file write failed', e.message); }
  }, 300);
}
async function persistProject(id) {
  if (!pool) return writeFileSoon();
  const p = projects.get(id);
  if (p) await pool.query('INSERT INTO timebox_docs (key, data, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', ['project:' + id, p]);
  else await pool.query('DELETE FROM timebox_docs WHERE key=$1', ['project:' + id]);
}
async function persistLive() {
  if (!pool) return writeFileSoon();
  await pool.query('INSERT INTO timebox_docs (key, data, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', ['live', { projectId: liveId }]);
}

/* ---------------- validation ---------------- */
const STATUSES = new Set(['idle', 'running', 'paused', 'stopped']);
const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi) ? v : undefined;
function cleanActivities(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 100).map((a, i) => ({
    id: (str(a && a.id, 40) || ('a' + i)).replace(/[^\w-]/g, ''),
    name: str(a && a.name, 80) ?? '',
    min: num(a && a.min, 0.1, 1440) ?? 1,
    color: /^#[0-9a-f]{6}$/i.test(a && a.color) ? a.color : '#7a8496',
  }));
}
function cleanPatch(b) {
  const out = {};
  if (!b || typeof b !== 'object') return out;
  const name = str(b.name, 80); if (name !== undefined) out.name = name.trim() || 'Untitled';
  if (STATUSES.has(b.status)) out.status = b.status;
  const anchor = num(b.anchor, 0, 1e14); if (anchor !== undefined) out.anchor = anchor;
  const elapsed = num(b.elapsed, 0, 1e10); if (elapsed !== undefined) out.elapsed = elapsed;
  const acts = cleanActivities(b.activities); if (acts) out.activities = acts;
  return out;
}

/* ---------------- live updates ---------------- */
const clients = new Set();
function snapshot() { return { type: 'state', now: Date.now(), liveId, projects: [...projects.values()] }; }
function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => {
  const msg = `data: ${JSON.stringify({ type: 'time', now: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}, 20000);

/* ---------------- auth ---------------- */
const fails = new Map(); // ip -> {n, t}
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function pinOk(req) {
  if (!PIN) return true;
  const ip = clientIp(req), f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 60000) return false;
  const given = Buffer.from(String(req.headers['x-timebox-pin'] || ''));
  const want = Buffer.from(PIN);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) fails.set(ip, { n: (f && Date.now() - f.t < 60000 ? f.n : 0) + 1, t: Date.now() });
  return ok;
}

/* ---------------- http ---------------- */
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object';
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 262144) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC });
      return fs.createReadStream(PAGE).pipe(res);
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, { ...snapshot(), pinRequired: !!PIN });
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/api/')) {
      if (!pinOk(req)) return send(res, 401, { error: 'Wrong or missing PIN' });
      if (req.method === 'POST' && p === '/api/unlock') return send(res, 200, { ok: true });

      if (req.method === 'POST' && p === '/api/projects') {
        if (projects.size >= 200) return send(res, 409, { error: 'Too many projects. Delete one first.' });
        const b = await readBody(req);
        const id = (str(b.id, 40) || ('p' + crypto.randomBytes(6).toString('hex'))).replace(/[^\w-]/g, '');
        if (projects.has(id)) return send(res, 409, { error: 'Exists' });
        const proj = { id, name: 'Untitled', status: 'idle', elapsed: 0, anchor: 0, activities: [], createdAt: Date.now(), ...cleanPatch(b) };
        projects.set(id, proj); await persistProject(id); broadcast();
        return send(res, 201, proj);
      }
      const m = p.match(/^\/api\/projects\/([\w-]{1,40})$/);
      if (m && req.method === 'PATCH') {
        const proj = projects.get(m[1]); if (!proj) return send(res, 404, { error: 'Not found' });
        Object.assign(proj, cleanPatch(await readBody(req)));
        await persistProject(proj.id); broadcast();
        return send(res, 200, proj);
      }
      if (m && req.method === 'DELETE') {
        projects.delete(m[1]);
        if (liveId === m[1]) { liveId = null; await persistLive(); }
        await persistProject(m[1]); broadcast();
        return send(res, 204, '');
      }
      if (req.method === 'PUT' && p === '/api/live') {
        const b = await readBody(req);
        liveId = (typeof b.projectId === 'string' && projects.has(b.projectId)) ? b.projectId : null;
        await persistLive(); broadcast();
        return send(res, 200, { liveId });
      }
      return send(res, 404, { error: 'Not found' });
    }
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    send(res, e.message === 'too large' ? 413 : 400, { error: 'Bad request' });
  }
});

storeInit().then(() => {
  server.listen(PORT, () => console.log(`timebox on :${PORT}${PIN ? ' (control PIN on)' : ' (no control PIN)'}`));
}).catch(e => { console.error('startup failed', e); process.exit(1); });
