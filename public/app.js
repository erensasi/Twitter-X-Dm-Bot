// =====================================================
// app.js — Frontend JavaScript
// =====================================================

// ─── Tab Yönetimi ────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'accounts') loadAccounts();
    if (tab === 'logs') loadLogs();
    if (tab === 'session') checkSession();
  });
});

// ─── WebSocket ───────────────────────────────────────
let ws;
function connectWS() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => console.log('WS bağlandı');
  ws.onmessage = (e) => handleWS(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connectWS, 3000);
}

function handleWS(msg) {
  switch (msg.type) {
    case 'log':
      appendLog(msg.data);
      break;
    case 'status':
      updateStatus(msg.data);
      break;
    case 'stats':
      updateStats(msg.data);
      break;
    case 'error':
      toast(msg.data.msg, 'error');
      break;
    case 'target':
      appendLog({ type: 'target', msg: `Hedef: @${msg.data.username}` });
      break;
  }
}

// ─── Log Yönetimi ────────────────────────────────────
const logContainer = document.getElementById('logContainer');
let logLines = [];

function appendLog(entry) {
  const emptyEl = logContainer.querySelector('.log-empty');
  if (emptyEl) emptyEl.remove();

  const d = new Date(entry.ts || Date.now());
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-type ${entry.type}">${entry.type}</span>
    <span class="log-msg">${entry.msg}</span>
  `;
  logContainer.appendChild(line);
  logContainer.scrollTop = logContainer.scrollHeight;
  logLines.push(entry);
}

function clearLog() {
  logContainer.innerHTML = '<div class="log-empty">Log temizlendi</div>';
  logLines = [];
}

// ─── Durum Güncelleme ────────────────────────────────
function updateStatus(data) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');

  if (data.running) {
    dot.className = 'status-dot running';
    txt.textContent = 'Çalışıyor';
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = false;
  } else {
    dot.className = 'status-dot';
    txt.textContent = 'Beklemede';
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    if (data.sent !== undefined) {
      toast(`Tamamlandı — ${data.sent} mesaj gönderildi, ${data.skipped} atlandı`, 'success');
    }
  }
}

// ─── İstatistik Güncelleme ───────────────────────────
function updateStats(data) {
  if (data.sent !== undefined) animateNum('statSent', data.sent);
  if (data.skipped !== undefined) animateNum('statSkipped', data.skipped);
  if (data.scanned !== undefined) animateNum('statScanned', data.scanned);
}

function animateNum(id, val) {
  const el = document.getElementById(id);
  const current = parseInt(el.textContent) || 0;
  if (current === val) return;
  el.textContent = val;
}

// ─── Gecikme Önizlemesi ──────────────────────────────
function parseTimeTxt(val) {
  const str = String(val);
  const parts = str.split('.');
  const m = parseInt(parts[0]) || 0;
  const s = parseInt((parts[1] || '0').padEnd(2, '0').slice(0, 2)) || 0;
  return `${m}dk ${s}sn`;
}

function updateDelayPreview() {
  const min = document.getElementById('minDelay').value;
  const max = document.getElementById('maxDelay').value;
  const el = document.getElementById('delayPreview');
  el.textContent = `Her DM arasında ${parseTimeTxt(min)} — ${parseTimeTxt(max)} arası rastgele bekleme`;
}

document.getElementById('minDelay').addEventListener('input', updateDelayPreview);
document.getElementById('maxDelay').addEventListener('input', updateDelayPreview);
updateDelayPreview();

// ─── Bot Başlat ──────────────────────────────────────
async function startBot() {
  const message = document.getElementById('message').value.trim();
  const minDelay = document.getElementById('minDelay').value;
  const maxDelay = document.getElementById('maxDelay').value;
  const minFollowers = parseInt(document.getElementById('minFollowers').value) || 10000;
  const maxPerAccount = parseInt(document.getElementById('maxPerAccount').value) || 500;
  const maxDMPerSession = parseInt(document.getElementById('maxDMPerSession').value) || 80;

  const passcode = document.getElementById('passcode')?.value.trim() || '';

  if (!message) { toast('Mesaj şablonu boş bırakılamaz!', 'error'); return; }

  const config = { message, minDelay, maxDelay, minFollowers, maxPerAccount, maxDMPerSession, passcode };

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    toast('Otomasyon başlatıldı ▶', 'success');
  } catch (err) {
    toast('Bağlantı hatası: ' + err.message, 'error');
  }
}

// ─── Bot Durdur ──────────────────────────────────────
async function stopBot() {
  await fetch('/api/stop', { method: 'POST' });
  toast('Durdurma isteği gönderildi...', 'info');
}

// ─── Hesap Listesi ────────────────────────────────────
async function loadAccounts() {
  const res = await fetch('/api/accounts');
  const data = await res.json();
  const ta = document.getElementById('accountsText');
  ta.value = data.content;
  updateAccountCount(data.content);
}

async function saveAccounts() {
  const content = document.getElementById('accountsText').value;
  await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  toast('Hesap listesi kaydedildi 💾', 'success');
}

function updateAccountCount(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  document.getElementById('accountsCount').textContent = `${lines.length} hesap`;
}

document.getElementById('accountsText')?.addEventListener('input', (e) => {
  updateAccountCount(e.target.value);
});

// ─── Session ─────────────────────────────────────────
async function checkSession() {
  const res = await fetch('/api/session/status');
  const data = await res.json();
  const dot = document.getElementById('sessionDot');
  const txt = document.getElementById('sessionStatusText');
  if (data.active) {
    dot.className = 'session-dot active';
    txt.textContent = 'Aktif oturum mevcut ✅';
  } else {
    dot.className = 'session-dot inactive';
    txt.textContent = 'Oturum bulunamadı — lütfen kaydet';
  }
}

async function saveSession() {
  const authToken = document.getElementById('authToken').value.trim();
  const ct0 = document.getElementById('ct0Token').value.trim();

  if (!authToken) { toast('auth_token zorunlu!', 'error'); return; }

  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authToken, ct0 })
  });
  const data = await res.json();
  if (data.ok) {
    toast('Oturum kaydedildi ✅', 'success');
    checkSession();
    document.getElementById('authToken').value = '';
    document.getElementById('ct0Token').value = '';
  } else {
    toast(data.error, 'error');
  }
}

async function deleteSession() {
  await fetch('/api/session', { method: 'DELETE' });
  toast('Oturum silindi', 'info');
  checkSession();
}

// ─── Log Tablosu ─────────────────────────────────────
async function loadLogs() {
  const res = await fetch('/api/logs');
  const logs = await res.json();
  const tbody = document.getElementById('logTableBody');

  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">Henüz kayıt yok</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(l => `
    <tr>
      <td>${new Date(l.date).toLocaleString('tr-TR')}</td>
      <td>@${l.username}</td>
      <td>${(l.followers || 0).toLocaleString()}</td>
      <td>@${l.target || '-'}</td>
      <td><span class="badge ${l.status === 'gönderildi' ? 'sent' : 'fail'}">${l.status}</span></td>
    </tr>
  `).join('');
}

// ─── Toast ───────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'info') {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─── Init ─────────────────────────────────────────────
connectWS();
checkSession();
