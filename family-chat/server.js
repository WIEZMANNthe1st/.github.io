// צ'אט משפחתי - שרת מקומי ללא אינטרנט
// הרצה: node server.js   (ללא התקנות, Node 16 ומעלה)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, 'messages.json');
const PAGE = path.join(__dirname, 'index.html');
const MAX_MESSAGES = 2000;
const MAX_BODY = 3 * 1024 * 1024; // 3MB (לתמונות מכווצות)

let messages = [];
try { messages = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { messages = []; }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(messages), () => {});
  }, 300);
}

const clients = new Set(); // חיבורי SSE פתוחים
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function onlineNames() {
  const names = new Set();
  for (const res of clients) if (res.userName) names.add(res.userName);
  return [...names];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    fs.createReadStream(PAGE).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.userName = (url.searchParams.get('name') || '').slice(0, 30);
    const since = Number(url.searchParams.get('since') || 0);
    res.write(`event: history\ndata: ${JSON.stringify(messages.filter(m => m.id > since))}\n\n`);
    clients.add(res);
    broadcast('online', onlineNames());
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      broadcast('online', onlineNames());
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    try {
      const body = JSON.parse(await readBody(req));
      const name = String(body.name || '').trim().slice(0, 30);
      const text = String(body.text || '').slice(0, 5000);
      const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : null;
      if (!name || (!text.trim() && !image)) throw new Error('empty');
      const last = messages[messages.length - 1];
      const msg = { id: Math.max(Date.now(), (last ? last.id : 0) + 1), name, text, image };
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
      save();
      broadcast('message', msg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: msg.id }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ✅ הצ\'אט המשפחתי פועל!\n');
  console.log('  פתחו באחת הכתובות האלה בדפדפן בכל טלפון שמחובר לאותה רשת Wi-Fi:\n');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`     http://${a.address}:${PORT}`);
    }
  }
  console.log(`\n  (במחשב עצמו: http://localhost:${PORT})\n  לעצירה: Ctrl+C\n`);
});
