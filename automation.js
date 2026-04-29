// =====================================================
// automation.js — Playwright otomasyon motoru
// =====================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let browser = null;
let running = false;
let stopRequested = false;

// ─── Yardımcı Fonksiyonlar ──────────────────────────

function log(type, msg, extra = {}) {
  const entry = { type, msg, ...extra, ts: new Date().toISOString() };
  console.log(`[${type.toUpperCase()}] ${msg}`);
  if (global.broadcast) global.broadcast('log', entry);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// "1.45" → 105000ms (1dk 45sn)
function parseTimeToMs(val) {
  const str = String(val);
  const parts = str.split('.');
  const minutes = parseInt(parts[0]) || 0;
  const seconds = parseInt((parts[1] || '0').padEnd(2, '0').slice(0, 2)) || 0;
  return (minutes * 60 + seconds) * 1000;
}

// minMs ile maxMs arasında rastgele bekleme
async function randomSleep(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const secs = Math.round(delay / 1000);
  log('delay', `${secs} saniye bekleniyor...`);
  await sleep(delay);
}

// @handle'dan username çıkar
function parseUsername(raw) {
  return raw.replace(/^@/, '').trim();
}

// Log dosyasına kaydet
function saveToLog(entry) {
  const logFile = path.join(__dirname, 'logs', 'sent.json');
  let logs = [];
  if (fs.existsSync(logFile)) {
    try { logs = JSON.parse(fs.readFileSync(logFile, 'utf-8')); } catch {}
  }
  logs.unshift({ ...entry, date: new Date().toISOString() });
  fs.writeFileSync(logFile, JSON.stringify(logs.slice(0, 5000), null, 2));
}

// ─── Session Yükleme ────────────────────────────────

async function loadSession(context) {
  const sessionFile = path.join(__dirname, 'session', 'cookies.json');
  if (!fs.existsSync(sessionFile)) {
    throw new Error('Session bulunamadı. Lütfen auth_token bilgisini panele girin.');
  }
  const cookies = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  await context.addCookies(cookies);
  log('info', 'Session yüklendi ✅');
}

// ─── Oturum Doğrulama ───────────────────────────────

async function verifyLogin(page) {
  // X.com SPA olduğu için 'networkidle' asla bitmez → 'domcontentloaded' kullan
  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    // Timeout olursa URL'yi yine de kontrol et
    log('info', 'Sayfa yüklemesi yavaş, devam ediliyor...');
  }
  // Sayfanın biraz render olması için bekle
  await sleep(3000);
  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow') || url.includes('signin')) {
    throw new Error('Giriş başarısız — auth_token geçersiz veya süresi dolmuş.');
  }
  log('info', `X oturumu doğrulandı ✅ (${url})`);
}

// ─── Takipçi Sayısı & Hassas Medya Kontrolü ─────────

// ─── Güvenli Sayfa Geçişi ─────────────────────────
// Her çağrıda taze sayfa açar → timeout'tan kalan bozuk sayfa sorununu önler
async function safeGoto(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });
    return page;
  } catch (e) {
    // Timeout olsa bile sayfa kısmen yüklenmiş olabilir, devam et
    const slug = url.split('/').pop();
    log('info', `Yavaş yükleme: ${slug} — devam ediliyor`);
    return page; // Yine de sayfayı döndür, belki içerik yüklüdür
  }
}

// ─── Takipçi Sayısı & Hassas Medya Kontrolü ─────────

async function checkProfile(context, username) {
  let page = null;
  try {
    page = await safeGoto(context, `https://x.com/${username}`);

    // Sayfanın gerçekten yüklenip yüklenmedini bekle
    const loaded = await page.waitForSelector(
      '[data-testid="primaryColumn"], [data-testid="UserName"]',
      { timeout: 20000 }
    ).catch(() => null);

    if (!loaded) {
      const url = page.url();
      if (url.includes('/login') || url.includes('/i/flow')) throw new Error('Oturum sona erdi!');
      return { ok: false, reason: 'profil_yuklenemedi' };
    }

    // followers linkini bekle
    await page.waitForSelector('a[href$="/followers"], a[href$="/verified_followers"]', { timeout: 16000 }).catch(() => null);
    await sleep(1000);

    // Hassas medya overlay
    const sensitiveBtn = await page.$('[data-testid="age_gate_consent_btn"]');
    if (sensitiveBtn) return { ok: false, reason: 'hassas_medya' };

    // Askıya alınmış hesap
    const emptyEl = await page.$('[data-testid="empty_state_body_text"]');
    if (emptyEl) return { ok: false, reason: 'hesap_askida' };

    // Takipçi sayısı — page.evaluate() ile direkt DOM erişimi
    const result = await page.evaluate((uname) => {
      // Yardımcı: metinden sayı çıkar
      function extractNum(txt) {
        if (!txt) return null;
        txt = txt.trim().replace(/,/g, '').replace(/\./g, '');
        // Türkçe/İngilizce kısaltmalar
        const m = txt.match(/([\d]+)\s*([KkMmBbTt]?)/);
        if (!m) return null;
        let n = parseInt(m[1]);
        const s = m[2].toUpperCase();
        if (s === 'K') n *= 1000;
        if (s === 'M') n *= 1000000;
        if (s === 'B' || s === 'T') n *= 1000000000;
        return isNaN(n) ? null : n;
      }

      // X bazen /followers, bazen /verified_followers linki üretiyor — ikisini de dene

      // Strateji A: tam href eşleşmesi (/followers VEYA /verified_followers)
      const exact = document.querySelector(
        `a[href="/${uname}/followers"], a[href="/${uname}/verified_followers"]`
      );
      if (exact) {
        for (const sp of exact.querySelectorAll('span')) {
          const t = sp.textContent?.trim() || '';
          if (/^[\d.,]+[KkMmBbTt]?$/.test(t)) {
            const n = extractNum(t);
            if (n !== null) return { followers: n, strategy: 'exact_span' };
          }
        }
        const fullTxt = exact.textContent || '';
        const m = fullTxt.match(/([\d.,]+[KkMmBbTt]?)\s*(Follower|Takip)/i);
        if (m) {
          const n = extractNum(m[1]);
          if (n !== null) return { followers: n, strategy: 'exact_fulltext' };
        }
        // Span'da sadece sayı yoksa tüm link metnindeki ilk sayıyı al
        const anyNum = fullTxt.match(/([\d.,]+[KkMmBbTt]?)/);
        if (anyNum) {
          const n = extractNum(anyNum[1]);
          if (n !== null && n >= 0) return { followers: n, strategy: 'exact_anynum' };
        }
      }

      // Strateji B: /followers VEYA /verified_followers ile biten tüm linkler
      const all = document.querySelectorAll(
        'a[href$="/followers"], a[href$="/verified_followers"]'
      );
      for (const link of all) {
        const aria = link.getAttribute('aria-label') || '';
        if (aria) {
          const m = aria.match(/([\d.,]+[KkMmBbTt]?)/);
          if (m) {
            const n = extractNum(m[1]);
            if (n !== null) return { followers: n, strategy: 'aria' };
          }
        }
        for (const sp of link.querySelectorAll('span')) {
          const t = sp.textContent?.trim() || '';
          if (/^[\d.,]+[KkMmBbTt]?$/.test(t)) {
            const n = extractNum(t);
            if (n !== null) return { followers: n, strategy: 'any_span' };
          }
        }
      }

      // Strateji C: sayfadaki "Followers" / "Takipçi" metnini bul
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent?.trim() || '';
        if (t.match(/^(Followers|Takipçi)$/i)) {
          const parent = node.parentElement;
          const prev = parent?.previousElementSibling;
          if (prev) {
            const n = extractNum(prev.textContent);
            if (n !== null) return { followers: n, strategy: 'text_walker' };
          }
        }
      }

      // Bulunamadı — debug
      const hrefs = Array.from(document.querySelectorAll('a[href*="follower"]'))
        .map(a => a.getAttribute('href')).slice(0, 5);
      return { followers: null, debug: hrefs };
    }, username);

    if (result.followers !== null) {
      return { ok: true, followers: result.followers };
    }

    // Debug
    if (result.debug && result.debug.length > 0) {
      log('info', `@${username} follower linkleri: ${result.debug.join(', ')}`);
    } else {
      log('info', `@${username} sayfada hiç follower linki yok`);
    }

    return { ok: false, reason: 'takipci_bulunamadi' };
  } catch (err) {
    if (err.message.includes('Oturum sona erdi')) throw err;
    return { ok: false, reason: 'hata: ' + err.message.substring(0, 60) };
  } finally {
    await page?.close().catch(() => {});
  }
}

// "12.5K" → 12500, "1.2M" → 1200000
function parseFollowerCount(text) {
  if (!text) return NaN;
  text = text.trim().replace(/,/g, '');
  const match = text.match(/([\d.]+)\s*([KkMmBb]?)/);
  if (!match) return NaN;
  let num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1000000;
  if (suffix === 'B') num *= 1000000000;
  return Math.round(num);
}

// ─── DM Gönder ──────────────────────────────────────

async function sendDM(context, username, messageTemplate, passcode = '') {
  let page = null;
  try {
    page = await safeGoto(context, `https://x.com/${username}`);
    await sleep(4000);

    // ── Aşama 1: Graduated Access & Bouncer Tespiti ─────────────────
    // X yeni hesaplarda "graduated_access" engeli koyar — bu durumda DM butonu
    // görünse bile compose kutusu yüklenmez. Önce bunu tespit et.
    const gradBlock = await page.$('[data-testid="graduated_access_prompt"], [href="/i/flow/graduated_access"]').catch(() => null);
    if (gradBlock) {
      return { ok: false, reason: 'graduated_access_engeli' };
    }

    // ── Aşama 2: Profil Sayfasından DM Butonu ──────────────────────
    const dmBtn = await page.$('[data-testid="sendDMFromProfile"]');
    if (dmBtn) {
      await dmBtn.click();
      await sleep(4000);
    } else {
      // DM butonu yok — ya kapalı ya da graduated_access nedeniyle gizli
      // Yedek: x.com/messages/compose?recipient_id kullan (önce user ID al)
      const userId = await page.evaluate(() => {
        try {
          const state = window.__INITIAL_STATE__;
          if (!state) return null;
          const users = state.entities?.users?.entities;
          if (!users) return null;
          return Object.keys(users)[0] || null;
        } catch { return null; }
      }).catch(() => null);

      if (userId) {
        log('info', `@${username}: DM butonu yok, compose URL deneniyor (ID: ${userId})...`);
        await page.goto(`https://x.com/messages/compose?recipient_id=${userId}`, {
          waitUntil: 'domcontentloaded', timeout: 50000
        }).catch(() => {});
        await sleep(4000);
      } else {
        return { ok: false, reason: 'dm_kapali' };
      }
    }

    // ── Aşama 3: Graduated Access / OCF Doğrulama Döngüsü ─────────

    for (let attempt = 0; attempt < 3; attempt++) {
      const verifyInput = await page.$(
        'input[data-testid="ocfEnterTextInput"], ' +
        'input[autocomplete="current-password"], ' +
        'input[name="password"], ' +
        'input[data-testid="LoginForm_Password_field"], ' +
        'input[type="password"]'
      ).catch(() => null);

      if (!verifyInput) break; // Dialog yok, devam et

      if (!passcode) {
        return { ok: false, reason: 'passcode_gerekli' };
      }

      log('info', `@${username}: Kimlik doğrulama (katman ${attempt + 1}) — passcode giriliyor...`);
      await verifyInput.click();
      await sleep(800);
      await verifyInput.fill(passcode);
      await sleep(1200);

      // Onayla butonu — önce daha spesifik olanları dene
      const confirmBtn = await page.$(
        '[data-testid="ocfEnterTextButton"], ' +
        '[data-testid="LoginForm_Login_Button"], ' +
        '[data-testid="ocf_form_next_link"], ' +
        'button[type="submit"]'
      ).catch(() => null);

      if (confirmBtn) {
        await confirmBtn.click();
      } else {
        await verifyInput.press('Enter');
      }
      await sleep(6000); // Dialog kapanması için bekle

      // Başarısız olursa (hata mesajı var mı?) kontrol et
      const errMsg = await page.$('[data-testid="toast"], [role="alert"]').catch(() => null);
      if (errMsg) {
        const errText = await errMsg.innerText().catch(() => '');
        if (errText.toLowerCase().includes('wrong') || errText.includes('incorrect') || errText.includes('yanlış')) {
          return { ok: false, reason: 'passcode_yanlis' };
        }
      }
    }

    // ── Ara Dialog Kontrolü ────────────────────────────────────────────
    // X bazen "Bu kişi seni takip etmiyor — yine de mesaj gönder?" dialog gösterir
    await sleep(1500);
    const midDialog = await page.$(
      '[data-testid="confirmationSheetConfirm"], ' +
      '[data-testid="dmRequestConfirmation"], ' +
      'button[data-testid="allowMessagesButton"]'
    ).catch(() => null);
    if (midDialog) {
      log('info', `@${username}: Mesaj isteği onay dialogu — onaylanıyor...`);
      await midDialog.click();
      await sleep(3000);
    }

    // ── Mesaj Kutusu — /i/chat/ yeni arayüzü de dahil ───────────────
    // Yeni X chat arayüzü: contenteditable="plaintext-only", role="textbox"
    // Eski DM arayüzü: dmComposerTextInput
    const COMPOSE_SELECTORS =
      '[data-testid="dmComposerTextInput"], ' +
      'div[data-testid="dmComposerTextInput"], ' +
      '[data-testid="tweetTextarea_0"], ' +
      'div[role="textbox"][contenteditable="true"], ' +
      'div[role="textbox"][contenteditable="plaintext-only"], ' +
      'div[role="textbox"], ' +
      'div[contenteditable="true"], ' +
      'div[contenteditable="plaintext-only"], ' +
      'textarea[placeholder], ' +
      '[aria-label="Message"], ' +
      '[placeholder*="message" i]';

    // /i/chat/ arayüzü için dm-conversation-panel'ın yüklenmesini bekle
    const chatUrl = page.url();
    if (chatUrl.includes('/i/chat/')) {
      await page.waitForSelector('[data-testid="dm-conversation-panel"]', { timeout: 15000 }).catch(() => {});
      await sleep(2000);
    }

    const msgBox = await page.waitForSelector(COMPOSE_SELECTORS, { timeout: 30000 }).catch(() => null);


    if (!msgBox) {
      const curUrl = page.url();
      log('info', `@${username}: Mesaj kutusu bulunamadı. URL: ${curUrl}`);

      // Sayfadaki tüm data-testid'leri logla (debug)
      const testIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid]')]
          .map(el => el.getAttribute('data-testid'))
          .filter(Boolean)
          .slice(0, 30)
      ).catch(() => []);
      if (testIds.length) {
        log('info', `@${username}: Sayfadaki data-testid'ler: ${testIds.join(', ')}`);
      }

      // Screenshot kaydet
      try {
        const fs = require('fs');
        const dir = './public/debug';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fname = `${dir}/dm_fail_${username}_${Date.now()}.png`;
        await page.screenshot({ path: fname, fullPage: false });
        log('info', `@${username}: Screenshot kaydedildi → /debug/${fname.split('/').pop()}`);
      } catch {}

      return { ok: false, reason: 'mesaj_kutusu_bulunamadi' };
    }


    const finalMsg = messageTemplate
      .replace(/{{isim}}/gi, username)
      .replace(/{{kullanici_adi}}/gi, '@' + username);

    // ── Mesajı Yaz ────────────────────────────────────────────────────
    // contenteditable="plaintext-only" için fill() çalışmıyor → keyboard.type kullan
    await msgBox.click();
    await sleep(1000);

    // Kutuyu temizle (varsa önceki metin)
    await page.keyboard.press('Control+a');
    await sleep(300);

    // Mesajı yaz — delay ile insan gibi
    await page.keyboard.type(finalMsg, { delay: 40 });
    await sleep(2000);

    // ── Gönder ───────────────────────────────────────────────────────
    // Metin yazıldıktan sonra send butonu aktif hale gelir — görünmesini bekle
    const sendBtnSelectors =
      '[data-testid="dmComposerSendButton"], ' +
      '[data-testid="dm-conversation-send-button"], ' +
      'button[aria-label="Send message"], ' +
      'button[aria-label="Send"], ' +
      'div[data-testid="dmComposerSendButton"]';

    let sendBtn = await page.waitForSelector(sendBtnSelectors, { timeout: 8000 }).catch(() => null);

    if (sendBtn) {
      await sendBtn.click();
      log('info', `@${username}: Gönder butonuna tıklandı`);
    } else {
      // Buton yoksa Enter ile gönder
      log('info', `@${username}: Gönder butonu yok, Enter basılıyor...`);
      await msgBox.press('Enter');
    }

    await sleep(4000);

    // ── Sonuç Kontrolü ────────────────────────────────────────────────
    // 1) X hata toast'u var mı? (failed to send, can't message vs.)
    const toastEl = await page.$('[data-testid="toast"]').catch(() => null);
    if (toastEl) {
      const toastText = await toastEl.innerText().catch(() => '');
      log('info', `@${username}: Toast mesajı: "${toastText.trim()}"`);
      if (toastText.match(/fail|error|can't|unable|engel|hata/i)) {
        // Screenshot ile kaydet
        try {
          const fs = require('fs');
          const dir = './public/debug';
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const fname = `${dir}/send_fail_${username}_${Date.now()}.png`;
          await page.screenshot({ path: fname, fullPage: false });
          log('info', `@${username}: Gönderim hatası screenshot → /debug/${fname.split('/').pop()}`);
        } catch {}
        return { ok: false, reason: 'gonderim_hatasi: ' + toastText.trim().substring(0, 60) };
      }
    }

    // 2) Kutu temizlendiyse başarılı gönderilmiştir
    const boxText = await msgBox.innerText().catch(() => '');
    if (boxText.trim().length === 0) {
      return { ok: true };
    }

    // 3) Kutu hâlâ doluysa — belirsiz, başarı say ama logla
    log('info', `@${username}: Kutu temizlenmedi (${boxText.substring(0, 30)}...) — başarı varsayılıyor`);
    return { ok: true };

  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    await page?.close().catch(() => {});
  }
}


// ─── Takipçi Listesi Çek ────────────────────────────

async function getFollowers(context, targetUsername, maxPerAccount) {
  const followers = new Set();
  log('info', `@${targetUsername} takipçileri taranıyor...`);
  const page = await safeGoto(context, `https://x.com/${targetUsername}/followers`);
  try {
    // İlk UserCell yüklenene kadar bekle (max 15sn)
    const firstCell = await page.waitForSelector('[data-testid="UserCell"]', { timeout: 30000 }).catch(() => null);
    if (!firstCell) {
      log('info', `@${targetUsername} takipçi listesi yüklenemedi veya boş`);
      return [];
    }
    await sleep(2000);
    let lastCount = 0;
    let noNewCount = 0;
    const MAX_NO_NEW = 8;

  while (followers.size < maxPerAccount && !stopRequested) {
    // Tüm görünür UserCell'leri topla
    const cells = await page.$$('[data-testid="UserCell"]');
    for (const cell of cells) {
      // Her cell içindeki ilk /username formatındaki link
      const links = await cell.$$('a[href^="/"]');
      for (const link of links) {
        const href = await link.getAttribute('href').catch(() => '');
        if (!href) continue;
        // /username formatı: tek slash, username kısmı, alt path yok
        const parts = href.split('/').filter(Boolean);
        if (parts.length === 1 && !parts[0].includes('?') && !parts[0].includes('.')) {
          followers.add(parts[0]);
          if (followers.size >= maxPerAccount) break;
        }
      }
      if (followers.size >= maxPerAccount) break;
    }

    log('scan', `${followers.size} / ${maxPerAccount} takipçi toplandı`);
    global.broadcast && global.broadcast('stats', { scanned: followers.size });

    if (followers.size >= maxPerAccount) break;

    // Yeni tak. geldiyse sifirla, gelmediyse say
    if (followers.size === lastCount) {
      noNewCount++;
      if (noNewCount >= MAX_NO_NEW) break; // Liste bitti
    } else {
      noNewCount = 0;
    }
    lastCount = followers.size;

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(4000); // X'in lazy-load'u için biraz bekle
  }

    log('info', `Toplam ${followers.size} takipçi toplandı`);
    return Array.from(followers);
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Ana Otomasyon ──────────────────────────────────

async function startAutomation(config) {
  if (running) throw new Error('Otomasyon zaten çalışıyor');

  const {
    message,
    minDelay,
    maxDelay,
    minFollowers = 10000,
    maxPerAccount = 500,
    maxDMPerSession = 100,
    passcode = ''
  } = config;

  const minMs = parseTimeToMs(minDelay);
  const maxMs = parseTimeToMs(maxDelay);

  // accounts.txt oku
  const accountsFile = path.join(__dirname, 'accounts.txt');
  if (!fs.existsSync(accountsFile)) throw new Error('accounts.txt bulunamadı');

  const lines = fs.readFileSync(accountsFile, 'utf-8').split('\n');
  const targetAccounts = lines
    .map(l => parseUsername(l.trim()))
    .filter(u => u.length > 0);

  if (targetAccounts.length === 0) throw new Error('accounts.txt boş');

  log('start', `Otomasyon başlatılıyor — ${targetAccounts.length} hedef hesap`);
  global.broadcast && global.broadcast('status', { running: true });

  running = true;
  stopRequested = false;

  let totalSent = 0;
  let totalSkipped = 0;
  let totalScanned = 0;

  browser = await chromium.launch({ headless: true, slowMo: 20 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  try {
    await loadSession(context);
    // verifyLogin için tek seferlik sayfa
    const loginPage = await context.newPage();
    await verifyLogin(loginPage);
    await loginPage.close();

    for (const target of targetAccounts) {
      if (stopRequested || totalSent >= maxDMPerSession) break;

      log('target', `Hedef: @${target}`);

      // getFollowers taze sayfa açıp kapayacak şekilde context alıyor
      const followers = await getFollowers(context, target, maxPerAccount);

      let consecutiveFailures = 0;

      for (const follower of followers) {
        if (stopRequested || totalSent >= maxDMPerSession) break;

        totalScanned++;
        log('check', `@${follower} kontrol ediliyor...`);

        // Çok fazla ardışık yüklenemedi hatası varsa session yenile
        if (consecutiveFailures >= 5) {
          log('info', '⚠️ Çok fazla hata — oturum yenileniyor...');
          const healPage = await context.newPage();
          try {
            await healPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(3000);
            const healUrl = healPage.url();
            if (healUrl.includes('/login') || healUrl.includes('/i/flow')) {
              throw new Error('Oturum sona erdi!');
            }
            log('info', 'Oturum hâlâ geçerli, devam ediliyor...');
          } finally {
            await healPage.close().catch(() => {});
          }
          consecutiveFailures = 0;
          await sleep(5000);
        }

        const profile = await checkProfile(context, follower);

        if (!profile.ok) {
          log('skip', `@${follower} atlandı → ${profile.reason}`);
          consecutiveFailures++;
          totalSkipped++;
          global.broadcast && global.broadcast('stats', { sent: totalSent, skipped: totalSkipped, scanned: totalScanned });
          await sleep(1000);
          continue;
        }
        consecutiveFailures = 0;

        if (profile.followers < minFollowers) {
          log('skip', `@${follower} atlandı → Takipçi: ${profile.followers.toLocaleString()} (< ${minFollowers.toLocaleString()})`);
          totalSkipped++;
          global.broadcast && global.broadcast('stats', { sent: totalSent, skipped: totalSkipped, scanned: totalScanned });
          await sleep(1000);
          continue;
        }

        // DM gönder
        log('dm', `@${follower} mesaj gönderiliyor (${profile.followers.toLocaleString()} takipçi)...`);
        const result = await sendDM(context, follower, message, passcode);

        if (result.ok) {
          totalSent++;
          log('sent', `✅ @${follower} → Gönderildi (Toplam: ${totalSent})`);
          saveToLog({ username: follower, followers: profile.followers, status: 'gönderildi', target });
        } else {
          log('fail', `❌ @${follower} → ${result.reason}`);
          saveToLog({ username: follower, followers: profile.followers, status: result.reason, target });
          totalSkipped++;
        }

        global.broadcast && global.broadcast('stats', { sent: totalSent, skipped: totalSkipped, scanned: totalScanned });

        // Rastgele bekleme
        if (!stopRequested) await randomSleep(minMs, maxMs);
      }

      // Hesaplar arası bekleme
      if (!stopRequested && targetAccounts.indexOf(target) < targetAccounts.length - 1) {
        log('delay', 'Sonraki hesaba geçiliyor, 3-5dk bekleniyor...');
        await randomSleep(3 * 60 * 1000, 5 * 60 * 1000);
      }
    }

  } catch (err) {
    log('error', 'Hata: ' + err.message);
    global.broadcast && global.broadcast('error', { msg: err.message });
  } finally {
    await browser?.close();
    browser = null;
    running = false;
    log('done', `Otomasyon tamamlandı — Gönderilen: ${totalSent}, Atlanan: ${totalSkipped}`);
    global.broadcast && global.broadcast('status', { running: false, sent: totalSent, skipped: totalSkipped });
  }
}

function stopAutomation() {
  stopRequested = true;
  log('stop', 'Durdurma isteği gönderildi...');
}

module.exports = { startAutomation, stopAutomation };
