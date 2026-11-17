// יוצר תעודת אבטחה (self-signed) כדי שהצ'אט יעבוד ב-https.
// הדפדפן דורש https כדי לאפשר הקלטה מהמיקרופון.
// נכתב ללא תלות ב-openssl, כך שעובד גם ב-Windows.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

function len(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(b.length), b]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
function oid(str) {
  const n = str.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f]; let x = v >> 7;
    while (x > 0) { b.unshift((x & 0x7f) | 0x80); x >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
const utcTime = d => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

function localIPs() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4') ips.push(a.address);
  return ips;
}

function generate(certFile, keyFile) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Family Chat'))));
  const now = new Date(Date.now() - 86400000);
  const until = new Date(now.getTime() + 10 * 365 * 86400000);
  const san = seq(
    tlv(0x82, Buffer.from('localhost')),
    ...localIPs().map(ip => tlv(0x87, Buffer.from(ip.split('.').map(Number))))
  );
  const extensions = tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, san))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),                 // version v3
    tlv(0x02, (() => { const r = crypto.randomBytes(8); r[0] = (r[0] & 0x7f) | 0x01; return r; })()), // serial
    sigAlg, name,
    seq(utcTime(now), utcTime(until)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, sigAlg, tlv(0x03, Buffer.from([0]), signature));
  const pem = '-----BEGIN CERTIFICATE-----\n' +
    cert.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(certFile, pem);
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
}

module.exports = function ensureCert(certFile, keyFile) {
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) generate(certFile, keyFile);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
};
