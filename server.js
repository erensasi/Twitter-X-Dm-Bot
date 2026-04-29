// =====================================================
// server.js — Express + WebSocket sunucu
// =====================================================
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { startAutomation, stopAutomation } = require('./automation');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dizinleri oluştur
['session', 'logs'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// Tüm bağlı istemcilere mesaj gönder
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

global.broadcast = broadcast;

// ─── API Rotaları ────────────────────────────────────

// Hesap listesini oku/yaz
app.get('/api/accounts', (req, res) => {
  const file = path.join(__dirname, 'accounts.txt');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  res.json({ content });
});

app.post('/api/accounts', (req, res) => {
  const file = path.join(__dirname, 'accounts.txt');
  fs.writeFileSync(file, req.body.content || '', 'utf-8');
  res.json({ ok: true });
});

// Session kaydet
app.post('/api/session', (req, res) => {
  const { authToken, ct0 } = req.body;
  if (!authToken) return res.status(400).json({ error: 'auth_token gerekli' });
  const sessionFile = path.join(__dirname, 'session', 'cookies.json');
  const cookies = [
    { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true },
    { name: 'ct0', value: ct0 || '', domain: '.x.com', path: '/', secure: true }
  ];
  fs.writeFileSync(sessionFile, JSON.stringify(cookies, null, 2));
  res.json({ ok: true });
});

// Session durumu kontrol
app.get('/api/session/status', (req, res) => {
  const sessionFile = path.join(__dirname, 'session', 'cookies.json');
  res.json({ active: fs.existsSync(sessionFile) });
});

// Session sil
app.delete('/api/session', (req, res) => {
  const sessionFile = path.join(__dirname, 'session', 'cookies.json');
  if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  res.json({ ok: true });
});

// Otomasyonu başlat
app.post('/api/start', (req, res) => {
  const config = req.body;
  startAutomation(config)
    .then(() => res.json({ ok: true }))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Otomasyonu durdur
app.post('/api/stop', (req, res) => {
  stopAutomation();
  res.json({ ok: true });
});

// Log dosyasını oku
app.get('/api/logs', (req, res) => {
  const logFile = path.join(__dirname, 'logs', 'sent.json');
  const logs = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf-8')) : [];
  res.json(logs);
});

// Log CSV olarak indir
app.get('/api/logs/csv', (req, res) => {
  const logFile = path.join(__dirname, 'logs', 'sent.json');
  const logs = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf-8')) : [];
  const csv = ['Tarih,Kullanıcı Adı,Takipçi Sayısı,Durum', ...logs.map(l =>
    `${l.date},${l.username},${l.followers},${l.status}`
  )].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dm_log.csv"');
  res.send('\uFEFF' + csv);
});

// WebSocket bağlantısı
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', data: 'Sunucuya bağlandı' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🤖 XBot çalışıyor → Port: ${PORT}\n`);
});