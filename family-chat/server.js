// צ'אט משפחתי - שרת מקומי ללא אינטרנט
// הרצה: node server.js   (ללא התקנות, Node 16 ומעלה)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ensureCert = require('./cert');

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const DIR = __dirname;
const DATA_FILE = path.join(DIR, 'data.json');
const MEDIA_DIR = path.join(DIR, 'media');
const PAGE = path.join(DIR, 'index.html');
const MAX_BODY = 10 * 1024 * 1024;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- מצב ושמירה ----------
let state = { messages: [], groups: [], reads: {}, users: [] };
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), err => { if (!err) fs.rename(tmp, DATA_FILE, () => {}); });
  }, 300);
}

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/3gpp': '3gp', 'audio/amr': 'amr' };
const EXT_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  wav: 'audio/wav', '3gp': 'audio/3gpp', amr: 'audio/amr', bin: 'application/octet-stream' };

function saveMedia(dataUrl, id) {
  const m = /^data:([^;,]+)[^,]*;base64,(.+)$/s.exec(dataUrl);
  if (!m || !/^(image|audio)\//.test(m[1])) return null;
  const ext = MIME_EXT[m[1]] || 'bin';
  const file = `${id}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), Buffer.from(m[2], 'base64'));
  return 'media/' + file;
}

function loadState() {
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch {
  // מעבר מהגרסה הקודמת (messages.json)
  try {
    const old = JSON.parse(fs.readFileSync(path.join(DIR, 'messages.json'), 'utf8'));
    for (const m of old) {
      m.chat = 'family';
      if (m.image && m.image.startsWith('data:')) m.image = saveMedia(m.image, m.id);
      if (!state.users.includes(m.name)) state.users.push(m.name);
    }
    state.messages = old;
  } catch {}
}
}
loadState();

// ---------- הרשאות צפייה ----------
const cleanName = s => String(s || '').replace(/[|\n\r]/g, '').trim().slice(0, 30);
function members(chat) {
  if (chat === 'family') return state.users;
  if (chat.startsWith('dm:')) return chat.slice(3).split('|');
  const g = state.groups.find(g => g.id === chat);
  return g ? g.members : [];
}
const canSee = (name, chat) => members(chat).includes(name) || (chat === 'family' && !!name);
const visibleGroups = name => state.groups.filter(g => g.members.includes(name));

// ---------- חיבורים בזמן אמת (SSE) ----------
const clients = new Set();
function emit(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data, filter = () => true) {
  for (const res of clients) if (filter(res.userName)) emit(res, event, data);
}
const online = () => [...new Set([...clients].map(r => r.userName))];
function addUser(name) {
  if (!state.users.includes(name)) { state.users.push(name); save(); broadcast('users', state.users); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

function serveMedia(req, res, file) {
  if (!/^[\w.-]+$/.test(file)) { res.writeHead(404); return res.end(); }
  const full = path.join(MEDIA_DIR, file);
  let stat; try { stat = fs.statSync(full); } catch { res.writeHead(404); return res.end(); }
  const type = EXT_MIME[file.split('.').pop()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=31536000, immutable' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) { // אייפון דורש תמיכה ב-Range כדי לנגן אודיו
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start); end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(full).pipe(res);
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(PAGE).pipe(res);
  }
  if (req.method === 'GET' && p.startsWith('/media/')) return serveMedia(req, res, p.slice(7));

  if (req.method === 'GET' && p === '/events') {
    const name = cleanName(url.searchParams.get('name'));
    if (!name) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.userName = name;
    addUser(name);
    const since = Number(url.searchParams.get('since') || 0);
    emit(res, 'init', {
      users: state.users,
      groups: visibleGroups(name),
      reads: state.reads,
      messages: state.messages.filter(m => m.id > since && canSee(name, m.chat)),
    });
    clients.add(res);
    broadcast('online', online());
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); broadcast('online', online()); });
    return;
  }

  if (req.method === 'POST' && p === '/send') {
    try {
      const b = await readBody(req);
      const name = cleanName(b.name);
      const chat = String(b.chat || 'family');
      const cid = String(b.cid || '').slice(0, 40);
      if (!name || !canSee(name, chat)) throw new Error('forbidden');
      addUser(name);
      // מניעת כפילויות כששליחה חוזרת אחרי ניתוק
      const dup = cid && state.messages.find(m => m.cid === cid && m.name === name);
      if (dup) return json(res, 200, { ok: true, id: dup.id });
      const last = state.messages[state.messages.length - 1];
      const id = Math.max(Date.now(), (last ? last.id : 0) + 1);
      const msg = { id, chat, name, cid, text: String(b.text || '').slice(0, 5000) };
      if (b.image) msg.image = saveMedia(String(b.image), id);
      if (b.audio) { msg.audio = saveMedia(String(b.audio), id); msg.duration = Number(b.duration) || 0; }
      if (!msg.text.trim() && !msg.image && !msg.audio) throw new Error('empty');
      state.messages.push(msg);
      // השולח קרא את ההודעה של עצמו
      (state.reads[chat] ||= {})[name] = id;
      save();
      broadcast('message', msg, n => canSee(n, chat));
      return json(res, 200, { ok: true, id });
    } catch { return json(res, 400, { ok: false }); }
  }

  if (req.method === 'POST' && p === '/read') {
    try {
      const b = await readBody(req);
      const name = cleanName(b.name), chat = String(b.chat || ''), id = Number(b.id) || 0;
      if (!name || !canSee(name, chat)) throw new Error('forbidden');
      const r = (state.reads[chat] ||= {});
      if ((r[name] || 0) < id) {
        r[name] = id; save();
        broadcast('read', { chat, name, id }, n => canSee(n, chat));
      }
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { ok: false }); }
  }

  if (req.method === 'POST' && p === '/group') {
    try {
      const b = await readBody(req);
      const name = cleanName(b.name);
      const title = String(b.title || '').trim().slice(0, 40);
      const mem = [...new Set([name, ...(b.members || []).map(cleanName)])].filter(Boolean);
      if (!name || !title || mem.length < 2) throw new Error('bad');
      const g = { id: 'g:' + Date.now(), title, members: mem, by: name };
      state.groups.push(g); save();
      for (const res2 of clients) if (mem.includes(res2.userName)) emit(res2, 'groups', visibleGroups(res2.userName));
      return json(res, 200, { ok: true, id: g.id });
    } catch { return json(res, 400, { ok: false }); }
  }

  res.writeHead(404); res.end();
}

// ---------- הפעלה ----------
const ips = [];
for (const list of Object.values(os.networkInterfaces()))
  for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);

http.createServer(handler).listen(PORT, '0.0.0.0');
let tls = null;
try { tls = ensureCert(path.join(DIR, 'cert.pem'), path.join(DIR, 'key.pem')); } catch (e) { console.log('לא ניתן ליצור תעודה:', e.message); }
if (tls) {
  try { https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0'); }
  catch (e) { tls = null; console.log('https לא זמין (' + e.message + '). מחקו את cert.pem ו-key.pem והפעילו מחדש.'); }
}

console.log('\n  ✅ הצ\'אט המשפחתי פועל!\n');
console.log('  פתחו בטלפונים (מחוברים לאותה רשת Wi-Fi):\n');
if (tls) for (const ip of ips) console.log(`     https://${ip}:${HTTPS_PORT}    ← מומלץ (כולל הודעות קוליות)`);
for (const ip of ips) console.log(`     http://${ip}:${PORT}`);
console.log('\n  בכניסה הראשונה ל-https תופיע אזהרה - לוחצים "מתקדם" ← "המשך לאתר".');
console.log('  לעצירה: Ctrl+C\n');
