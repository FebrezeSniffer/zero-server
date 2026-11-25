// ZEROFRAME Arena server: live 1v1 over WebSocket (server-authoritative health, kills, match end)
// plus REST for leaderboards, score duels and player tags. One file, one dependency (ws).
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || './data.json';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';   // set to your game's URL in production
const TICK_HZ = 30;                                          // state relay rate per player
const KILLS_TO_WIN = 5, MATCH_MS = 180000, RESPAWN_MS = 3000, MAX_HIT = 140;
const MODES = new Set(['flick', 'grid', 'track']);

// ---------- storage (JSON file, flushed every 5 s) ----------
let db = { scores: [], duels: {}, tags: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { /* first run */ }
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => { if (!dirty) return; dirty = false; fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}); }, 5000);

const code6 = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; const b = randomBytes(6); for (const x of b) s += A[x % A.length]; return s; };
const clean = (s, n = 16) => String(s ?? '').replace(/[^\w .\-]/g, '').trim().slice(0, n) || 'Player';
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };

// ---------- tiny rate limiter (per IP, per minute) ----------
const hits = new Map();
const limited = (ip, max = 120) => { const now = Date.now(), e = hits.get(ip) ?? { n: 0, t: now }; if (now - e.t > 60000) { e.n = 0; e.t = now; } e.n++; hits.set(ip, e); return e.n > max; };

// ---------- REST ----------
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, bad) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 20000) { bad(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('bad json')); } });
});

const server = http.createServer(async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || '?';
  if (req.method === 'OPTIONS') return send(res, 204);
  if (limited(ip)) return send(res, 429, { error: 'Too many requests' });
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (p === '/health') return send(res, 200, { ok: true, rooms: rooms.size });

    if (p === '/api/scores' && req.method === 'GET') {
      const mode = url.searchParams.get('mode');
      return send(res, 200, db.scores.filter((s) => s.mode === mode).sort((a, b) => b.score - a.score).slice(0, 100));
    }
    if (p === '/api/scores' && req.method === 'POST') {
      const b = await readBody(req);
      if (!MODES.has(b.mode)) return send(res, 400, { error: 'Unknown mode' });
      const e = { id: code6() + Date.now().toString(36), name: clean(b.name), mode: b.mode, score: num(b.score, 0, 100000), accuracy: num(b.accuracy, 0, 100),
        reactMs: b.reactMs == null ? null : num(b.reactMs, 0, 10000), hits: num(b.hits, 0, 100000), shots: num(b.shots, 0, 100000), kills: num(b.kills, 0, 1000), at: Date.now() };
      db.scores.push(e); if (db.scores.length > 20000) db.scores = db.scores.sort((a, b2) => b2.score - a.score).slice(0, 15000); save();
      return send(res, 201, e);
    }
    if (p === '/api/duels' && req.method === 'GET') {
      return send(res, 200, Object.values(db.duels).sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt)).slice(0, 100));
    }
    if (p === '/api/duels' && req.method === 'POST') {
      const b = await readBody(req); if (!MODES.has(b.mode)) return send(res, 400, { error: 'Unknown mode' });
      const d = { id: code6(), mode: b.mode, seed: num(b.seed, 0, 2 ** 31), host: clean(b.host), hostScore: num(b.hostScore, 0, 100000), hostAcc: num(b.hostAcc, 0, 100), createdAt: Date.now() };
      db.duels[d.id] = d; save(); return send(res, 201, d);
    }
    const dm = p.match(/^\/api\/duels\/([A-Z0-9]{6})$/);
    if (dm && req.method === 'GET') { const d = db.duels[dm[1]]; return d ? send(res, 200, d) : send(res, 404, { error: 'No duel with that code.' }); }
    if (dm && req.method === 'PUT') {
      const d = db.duels[dm[1]]; if (!d) return send(res, 404, { error: 'No duel with that code.' });
      if (d.challengerScore !== undefined) return send(res, 409, d);
      const b = await readBody(req);
      Object.assign(d, { challenger: clean(b.challenger), challengerScore: num(b.challengerScore, 0, 100000), challengerAcc: num(b.challengerAcc, 0, 100), doneAt: Date.now() });
      save(); return send(res, 200, d);
    }
    const tm = p.match(/^\/api\/tags\/([\w-]{8,64})$/);   // device id chosen by the client
    if (tm && req.method === 'GET') return send(res, 200, { tag: db.tags[tm[1]] ?? null });
    if (tm && req.method === 'PUT') { const b = await readBody(req); db.tags[tm[1]] = clean(b.tag); save(); return send(res, 200, { tag: db.tags[tm[1]] }); }

    return send(res, 404, { error: 'Not found' });
  } catch (e) { return send(res, 400, { error: e.message || 'Bad request' }); }
});

// ---------- live 1v1 ----------
// Room: two players. Server owns HP, kills and the clock; clients own their movement and report hits.
const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/live', maxPayload: 4096 });
const out = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const other = (room, ws) => (room.host === ws ? room.guest : room.host);

const endMatch = (room, reason) => {
  if (room.ended) return; room.ended = true; clearInterval(room.loop);
  const h = room.p.get(room.host), g = room.p.get(room.guest);
  const winner = !h || !g ? (h ? 'host' : 'guest') : h.kills === g.kills ? 'draw' : h.kills > g.kills ? 'host' : 'guest';
  for (const ws of [room.host, room.guest]) out(ws, { t: 'end', reason, winner, score: { host: h?.kills ?? 0, guest: g?.kills ?? 0 } });
  setTimeout(() => rooms.delete(room.code), 30000);
};

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN !== '*' && origin !== ALLOWED_ORIGIN) { ws.close(1008, 'origin'); return; }
  let room = null, role = null, lastState = 0, msgs = 0, msgT = Date.now();
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const now = Date.now(); if (now - msgT > 1000) { msgs = 0; msgT = now; } if (++msgs > 90) return; // flood guard
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'host' && !room) {
      let code; do code = code6(); while (rooms.has(code));
      room = { code, host: ws, guest: null, p: new Map(), started: 0, ended: false, loop: null };
      room.p.set(ws, { name: clean(m.name), hp: 100, kills: 0, deadAt: 0 }); role = 'host'; rooms.set(code, room);
      return out(ws, { t: 'hosted', code });
    }
    if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r || r.ended) return out(ws, { t: 'error', error: 'No live match with that code.' });
      if (r.guest) return out(ws, { t: 'error', error: 'That match is full.' });
      room = r; role = 'guest'; r.guest = ws; r.p.set(ws, { name: clean(m.name), hp: 100, kills: 0, deadAt: 0 });
      r.started = now;
      const hn = r.p.get(r.host).name, gn = r.p.get(ws).name;
      out(r.host, { t: 'start', role: 'host', vs: gn, endsAt: now + MATCH_MS, killsToWin: KILLS_TO_WIN });
      out(ws, { t: 'start', role: 'guest', vs: hn, endsAt: now + MATCH_MS, killsToWin: KILLS_TO_WIN });
      r.loop = setInterval(() => {
        const t = Date.now();
        for (const [pws, ps] of r.p) if (ps.deadAt && t - ps.deadAt > RESPAWN_MS) { ps.deadAt = 0; ps.hp = 100; for (const w of [r.host, r.guest]) out(w, { t: 'respawn', who: pws === r.host ? 'host' : 'guest' }); }
        if (t - r.started > MATCH_MS) endMatch(r, 'time');
      }, 200);
      return;
    }
    if (!room || room.ended) return;
    const me = room.p.get(ws), opp = other(room, ws), them = room.p.get(opp);

    if (m.t === 'state') {          // movement / aim, relayed at most TICK_HZ per player
      if (now - lastState < 1000 / TICK_HZ - 2) return; lastState = now;
      return out(opp, { t: 'state', x: num(m.x, -500, 500), y: num(m.y, -10, 50), z: num(m.z, -500, 500), yaw: num(m.yaw, -100, 100), pitch: num(m.pitch, -3, 3),
        lean: num(m.lean, -1, 1), crouch: num(m.crouch, 0, 1), weapon: num(m.weapon, 0, 40), at: now });
    }
    if (m.t === 'fire') return out(opp, { t: 'fire', weapon: num(m.weapon, 0, 40) });
    if (m.t === 'hit') {            // shooter reports a hit; server applies it (capped) and decides kills
      if (!them || them.deadAt || me.deadAt) return;
      const dmg = num(m.dmg, 0, MAX_HIT), head = !!m.head;
      them.hp = Math.max(0, them.hp - dmg);
      out(opp, { t: 'damage', hp: them.hp, head, from: role });
      out(ws, { t: 'confirm', hp: them.hp, head });
      if (them.hp <= 0) {
        them.deadAt = now; me.kills++;
        const score = { host: room.p.get(room.host).kills, guest: room.p.get(room.guest)?.kills ?? 0 };
        for (const w of [room.host, room.guest]) out(w, { t: 'kill', killer: role, head, score });
        if (me.kills >= KILLS_TO_WIN) endMatch(room, 'kills');
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const opp = other(room, ws);
    if (!room.ended && room.started) { out(opp, { t: 'left' }); endMatch(room, 'left'); }
    else if (!room.started) rooms.delete(room.code);
  });
});

// drop dead sockets every 15 s
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);

server.listen(PORT, () => console.log(`ZEROFRAME server on :${PORT}`));
