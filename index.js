'use strict';
/*
 * Parental Bot Server v1
 * - Bot Telegram untuk orang tua (remote control)
 * - HTTP API untuk aplikasi Android anak (pairing pakai CHILD_CODE)
 * Tanpa dependensi: hanya modul bawaan Node.js + fetch global.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- config ----------
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
loadEnv();
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PARENT_IDS = (process.env.PARENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const CHILD_CODE = process.env.CHILD_CODE || 'ganti-kode-rahasia-ini';
// Di Pterodactyl port dialokasikan panel lewat SERVER_PORT — itu yang diutamakan.
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);

// ---------- database (JSON file) ----------
const DB_PATH = path.join(__dirname, 'database.json');
let db = {
  devices: {},        // deviceId -> {name, model, android, lastSeen, battery, foregroundApp}
  usage: {},          // deviceId -> {date, totalMinutes, apps:[{package,label,minutes}], receivedAt}
  policy: {           // satu kebijakan untuk semua HP anak (v1)
    locked: false,
    scareActive: false,            // true = layar HP anak sedang menampilkan video peringatan (polisi)
    pauseUntil: 0,                 // JEDA PERANGKAT: epoch ms sampai kapan perangkat dijeda total
    dailyLimitMinutes: 0,          // 0 = tanpa batas
    perAppLimits: {},              // package -> menit/hari
    blockedApps: [],               // [package]
    schedules: []                  // [{from:"19:00", to:"21:00", label:"belajar"}]
  },
  commands: [],       // [{id, deviceId|'*', type, payload, createdAt, delivered}]
  scareVideo: null    // {fileId, fileName, setAt} video peringatan (mis. polisi) dari orang tua
};
function saveDb() { try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 1)); } catch (e) {} }
function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))); } catch (e) {}
  }
}
loadDb();

const now = () => Date.now();
function firstDeviceId() { const k = Object.keys(db.devices); return k.length ? k[0] : null; }
function deviceOnline(d) { return d && (now() - (d.lastSeen || 0) < 120000); }
function queueCommand(type, payload) {
  const cmd = { id: crypto.randomBytes(4).toString('hex'), deviceId: '*', type, payload: payload || {}, createdAt: now(), delivered: false };
  db.commands.push(cmd); saveDb(); return cmd;
}

// ---------- Telegram ----------
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({}));
}
function isParent(id) { return PARENT_IDS.includes(String(id)); }
function fmtMin(m) { m = Math.round(m || 0); if (m < 60) return m + ' mnt'; return Math.floor(m / 60) + ' jam ' + (m % 60 ? (m % 60) + ' mnt' : '').trim(); }

// Tata letak mengikuti aturan user: 2 tombol sebaris; sisa tanpa pasangan = 1 baris full wide.
const MENU = {
  inline_keyboard: [
    [{ text: '🚨 VIDEO POLISI — TAMPILKAN SEKARANG', callback_data: 'polisi' }],
    [{ text: 'TAUT HP', callback_data: 'taut' }, { text: 'MATIKAN HP', callback_data: 'matikan' }],
    [{ text: 'TIMER PERANGKAT', callback_data: 'timer' }, { text: 'JEDA PERANGKAT', callback_data: 'jeda' }],
    [{ text: '✅ Matikan Video Polisi', callback_data: 'polisi_off' }, { text: '📊 Laporan', callback_data: 'laporan' }],
    [{ text: '📱 Status HP', callback_data: 'status' }, { text: '🔒 Kunci HP', callback_data: 'kunci' }],
    [{ text: '🔓 Buka Kunci', callback_data: 'buka' }, { text: '🚫 Daftar Blokir', callback_data: 'daftarblokir' }],
    [{ text: '⏱ Batas Waktu', callback_data: 'info_batas' }, { text: '🗓 Jadwal Kunci', callback_data: 'info_jadwal' }],
    [{ text: '🔑 Kode Pairing', callback_data: 'kode' }]
  ]
};

// ---------- Rich Message (tabel asli + button kapsul di badan pesan) ----------
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Kapsul Rich lebarnya mengikuti teks — samakan panjang label sepasang dengan
// spasi non-breaking di kiri/kanan agar tombol tampil simetris (pilihan user).
function padLabel(text, target) {
  let t = String(text);
  let len = [...t].length;
  let side = true;
  while (len < target) { t = side ? '\u00A0' + t : t + '\u00A0'; side = !side; len++; }
  return t;
}
function startRichHtml() {
  const id = firstDeviceId(); const d = id ? db.devices[id] : null; const p = db.policy;
  const status = !d ? 'Belum tertaut' : (deviceOnline(d) ? 'Online' : 'Offline');
  const jeda = p.pauseUntil && p.pauseUntil > now() ? 'Dijeda s/d ' + new Date(p.pauseUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : 'Tidak dijeda';
  return ''
    + '<h3>Selamat Datang di Parental Control</h3>'
    + '<blockquote>Halo Ayah/Bunda. Dari sini Anda mengendalikan HP anak: tautkan perangkat, matikan layar, atur timer bermain, dan jeda perangkat kapan pun perlu. Satu tombol darurat di paling atas: <b>VIDEO POLISI</b>, sekali tekan layar HP anak langsung menampilkannya.</blockquote>'
    + '<table bordered striped>'
    + '<tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Perangkat Anak</td><td>' + esc(d ? d.name : 'Belum ada') + '</td></tr>'
    + '<tr><td>Status</td><td>' + esc(status) + (d && d.battery != null ? ' · Baterai ' + d.battery + '%' : '') + '</td></tr>'
    + '<tr><td>Timer Hari Ini</td><td>' + (p.dailyLimitMinutes ? fmtMin(p.dailyLimitMinutes) + ' / hari' : 'Tanpa batas') + '</td></tr>'
    + '<tr><td>Jeda Perangkat</td><td>' + esc(jeda) + '</td></tr>'
    + '<tr><td>Video Polisi</td><td>' + (db.scareVideo ? 'Siap dipakai' : 'Belum dipasang (kirim video ke bot ini)') + '</td></tr>'
    + '<tr><td>Layar Terkunci</td><td>' + (p.locked ? 'Ya' : 'Tidak') + '</td></tr>'
    + '</table>'
    // Aturan tata letak user: tombol berpasangan 2 sebaris rapi;
    // yang tidak punya pasangan tampil 1 baris full wide.
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="polisi">' + padLabel('🚨 VIDEO POLISI', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="taut">' + padLabel('TAUT HP', 10) + '</tg-button><tg-button type="callback_data" style="danger" data="matikan">' + padLabel('MATIKAN HP', 10) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="timer">' + padLabel('TIMER PERANGKAT', 15) + '</tg-button><tg-button type="callback_data" style="success" data="jeda">' + padLabel('JEDA PERANGKAT', 15) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="polisi_off">' + padLabel('Matikan Video Polisi', 21) + '</tg-button><tg-button type="callback_data" style="link" data="laporan">' + padLabel('Laporan', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="status">' + padLabel('Status HP', 32) + '</tg-button></tg-button-row>';
}
function timerRichHtml() {
  const p = db.policy;
  return ''
    + '<h3>TIMER PERANGKAT</h3>'
    + '<blockquote>Atur batas total waktu main anak per hari. Lewat dari batas ini, perangkat terkunci otomatis sampai besok. Pilih cepat di bawah, atau ketik /batas &lt;menit&gt; untuk angka bebas.</blockquote>'
    + '<table bordered striped>'
    + '<tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Timer Saat Ini</td><td>' + (p.dailyLimitMinutes ? fmtMin(p.dailyLimitMinutes) + ' / hari' : 'Tanpa batas') + '</td></tr>'
    + '<tr><td>Timer Per Aplikasi</td><td>' + (Object.keys(p.perAppLimits || {}).length ? Object.keys(p.perAppLimits).length + ' aplikasi dibatasi' : 'Belum ada') + '</td></tr>'
    + '</table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="timer_30">' + padLabel('30 Menit', 8) + '</tg-button><tg-button type="callback_data" style="primary" data="timer_60">' + padLabel('60 Menit', 8) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="timer_90">' + padLabel('90 Menit', 9) + '</tg-button><tg-button type="callback_data" style="primary" data="timer_120">' + padLabel('120 Menit', 9) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="timer_0">' + padLabel('Tanpa Batas', 11) + '</tg-button><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 11) + '</tg-button></tg-button-row>';
}
function jedaRichHtml() {
  const p = db.policy;
  const sisa = p.pauseUntil && p.pauseUntil > now() ? Math.ceil((p.pauseUntil - now()) / 60000) : 0;
  return ''
    + '<h3>JEDA PERANGKAT</h3>'
    + '<blockquote>Selama jeda, semua aplikasi di HP anak tertutup. Jeda berakhir sendiri saat waktunya habis, atau akhiri lebih awal dari sini.</blockquote>'
    + '<table bordered striped>'
    + '<tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Status Jeda</td><td>' + (sisa ? 'Sedang dijeda' : 'Tidak dijeda') + '</td></tr>'
    + '<tr><td>Sisa Jeda</td><td>' + (sisa ? '±' + sisa + ' menit (s/d ' + new Date(p.pauseUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ')' : '-') + '</td></tr>'
    + '</table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="jeda_15">' + padLabel('Jeda 15 Menit', 13) + '</tg-button><tg-button type="callback_data" style="success" data="jeda_30">' + padLabel('Jeda 30 Menit', 13) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="jeda_60">' + padLabel('Jeda 60 Menit', 13) + '</tg-button><tg-button type="callback_data" style="danger" data="jeda_off">' + padLabel('Akhiri Jeda', 13) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 28) + '</tg-button></tg-button-row>';
}
async function sendRich(chatId, html, fallbackText) {
  try {
    const r = await tg('sendRichMessage', { chat_id: chatId, rich_message: { html } });
    if (r && r.ok) return r;
  } catch (e) {}
  return tg('sendMessage', { chat_id: chatId, parse_mode: 'Markdown', text: fallbackText, reply_markup: MENU });
}

function laporanText() {
  const id = firstDeviceId(); if (!id) return 'Belum ada HP anak yang terhubung.\nInstall aplikasi anak dulu, lalu masukkan kode pairing.';
  const u = db.usage[id]; const d = db.devices[id];
  if (!u) return 'HP *' + (d ? d.name : id) + '* terhubung, tapi laporan pemakaian pertama belum masuk (masuk tiap ±5 menit).';
  let t = '📊 *Laporan pemakaian — ' + (d ? d.name : 'HP anak') + '*\nTanggal: ' + u.date + '\nTotal: *' + fmtMin(u.totalMinutes) + '*\n\n';
  const apps = (u.apps || []).slice().sort((a, b) => b.minutes - a.minutes).slice(0, 15);
  for (const a of apps) t += '• ' + (a.label || a.package) + ' — ' + fmtMin(a.minutes) + '\n';
  return t;
}
function statusText() {
  const id = firstDeviceId(); if (!id) return 'Belum ada HP anak yang terhubung.';
  const d = db.devices[id];
  return '📱 *Status HP anak*\nNama: ' + d.name + '\nModel: ' + (d.model || '-') + ' (Android ' + (d.android || '-') + ')\nStatus: ' + (deviceOnline(d) ? '🟢 Online' : '🔴 Offline (terakhir ' + new Date(d.lastSeen || 0).toLocaleString('id-ID') + ')') + '\nBaterai: ' + (d.battery != null ? d.battery + '%' : '-') + '\nAplikasi terbuka: ' + (d.foregroundApp || '-') + '\nTerkunci: ' + (db.policy.locked ? 'Ya 🔒' : 'Tidak');
}
function batasText() {
  const p = db.policy; let t = '⏱ *Batas waktu saat ini*\nTotal harian: ' + (p.dailyLimitMinutes ? fmtMin(p.dailyLimitMinutes) : 'tanpa batas') + '\n\nBatas per aplikasi:\n';
  const keys = Object.keys(p.perAppLimits || {});
  t += keys.length ? keys.map(k => '• ' + k + ' — ' + fmtMin(p.perAppLimits[k])).join('\n') : '(belum ada)';
  t += '\n\nUbah dengan:\n`/batas 180` = total 180 menit/hari\n`/batas 0` = hapus batas total\n`/batasapp com.zhiliaoapp.musically 60` = TikTok max 60 menit/hari';
  return t;
}
function jadwalText() {
  const s = db.policy.schedules || [];
  let t = '🗓 *Jadwal kunci otomatis*\n' + (s.length ? s.map((x, i) => (i + 1) + '. ' + x.from + '–' + x.to + (x.label ? ' (' + x.label + ')' : '')).join('\n') : '(belum ada)') +
    '\n\nTambah: `/jadwal 19:00-21:00 belajar`\nHapus semua: `/hapusjadwal`';
  return t;
}

async function handleCommand(msg) {
  const chatId = msg.chat.id; const fromId = msg.from && msg.from.id;
  const text = (msg.text || '').trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase(); const arg = rest.join(' ');

  if (cmd === '/start') {
    if (!isParent(fromId)) {
      return tg('sendMessage', { chat_id: chatId, text: 'Bot parental ini khusus orang tua.\nID Telegram kamu: ' + fromId + '\nMasukkan ID itu ke PARENT_IDS di file .env server, lalu restart bot.' });
    }
    return sendRich(chatId, startRichHtml(), '👨‍👩‍👧 *Parental Control*\nTombol paling atas adalah tombol daruratmu: *satu kali tekan, layar HP anak langsung jadi video polisi* dan terkunci di sana sampai kamu matikan.\n\nPilih menu di bawah, atau pakai perintah:\n/laporan /status /kunci /buka\n/blokir <paket> /izin <paket>\n/batas <menit> /batasapp <paket> <menit>\n/jadwal <HH:MM-HH:MM> <label>\n/videopolisi — video yang muncul saat HP dibatasi (atau kirim video langsung ke sini)');
  }
  if (!isParent(fromId)) return tg('sendMessage', { chat_id: chatId, text: 'Maaf, menu ini khusus orang tua yang terdaftar.' });

  const send = (t, extra) => tg('sendMessage', Object.assign({ chat_id: chatId, parse_mode: 'Markdown', text: t }, extra || {}));
  const setTimerCmd = (n) => { db.policy.dailyLimitMinutes = n; saveDb(); return send('◷ *TIMER PERANGKAT diatur: ' + (n === 0 ? 'tanpa batas' : fmtMin(n) + ' / hari') + '.*\nLewat dari itu, perangkat anak terkunci sampai besok.'); };
  const setJedaCmd = (mnt) => {
    db.policy.pauseUntil = now() + mnt * 60000; queueCommand('pause'); saveDb();
    return send('⏸ *PERANGKAT DIJEDA ' + mnt + ' menit* (s/d ' + new Date(db.policy.pauseUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ').\nSemua aplikasi tertutup selama jeda. Akhiri lebih awal dengan tombol Jedanya lagi lalu pilih Akhiri Jeda, atau /buka.');
  };

  // Orang tua mengirim video apa pun ke bot = video itu jadi video peringatan
  // yang diputar full-screen di HP anak setiap kali aplikasi dibatasi/dikunci.
  const vid = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (vid && vid.file_id) {
    db.scareVideo = { fileId: vid.file_id, fileName: vid.file_name || 'video-peringatan.mp4', setAt: now() };
    saveDb();
    return send('🎬 Video peringatan *tersimpan*. Mulai sekarang, setiap anak membuka aplikasi yang diblokir / melewati batas waktu / HP dikunci, video ini yang muncul full-screen di HP anak.\n\nGanti video: kirim video baru saja ke sini.\nHapus: /hapusvideo');
  }
  switch (cmd) {
    case '/taut': {
      const id = firstDeviceId(); const d = id ? db.devices[id] : null;
      return send('🔗 *TAUT HP ANAK*\nStatus: ' + (d ? (deviceOnline(d) ? '🟢 Tertaut & online — ' + d.name : 'Tertaut, sedang offline — ' + d.name) : 'Belum ada HP yang tertaut') + '\n\nCara menautkan / menautkan ulang:\n1. Buka aplikasi *Parental Kids* di HP anak\n2. Alamat server: alamat server Pterodactyl ini (lihat menu Network di panel, format `http://domain:port`)\n3. Kode pairing: `' + CHILD_CODE + '`\n4. Tekan *Simpan + Hubungkan*, aktifkan semua izin, lalu *Mulai Pemantauan*');
    }
    case '/matikan':
      // Urutan wajib dari user: SEBELUM MATI, video polisi tampil dulu (±20 detik), baru layar mati.
      db.policy.locked = true; db.policy.scareActive = true; queueCommand('matikan'); saveDb();
      return send(db.scareVideo
        ? '⏻ *MATIKAN HP dikirim.* Urutannya: dalam ±10 detik *video polisi tampil dulu ±20 detik* di layar HP anak, setelah itu layarnya *mati & terkunci*. Saat layar dinyalakan lagi, video itu tetap tampil sampai kamu tekan /buka.'
        : '⏻ *MATIKAN HP dikirim.* Layar HP anak mati & terkunci dalam ±10 detik.\nCatatan: video polisi belum dipasang, jadi langsung mati tanpa video dulu. Kirim videonya ke chat ini kalau mau ada video sebelum mati.');
    case '/timer':
      return sendRich(chatId, timerRichHtml(), '◷ *TIMER PERANGKAT*\nBatas main saat ini: *' + (db.policy.dailyLimitMinutes ? fmtMin(db.policy.dailyLimitMinutes) + ' / hari' : 'tanpa batas') + '*\nPilih cepat di bawah, atau ketik `/batas <menit>` (0 = tanpa batas).');
    case '/timer30': return setTimerCmd(30);
    case '/timer60': return setTimerCmd(60);
    case '/timer90': return setTimerCmd(90);
    case '/timer120': return setTimerCmd(120);
    case '/timer0': return setTimerCmd(0);
    case '/jeda':
      return sendRich(chatId, jedaRichHtml(), '⏸ *JEDA PERANGKAT*\nPilih lama jeda dari menu /start.');
    case '/jeda15': return setJedaCmd(15);
    case '/jeda30': return setJedaCmd(30);
    case '/jeda60': return setJedaCmd(60);
    case '/jedabatal':
      db.policy.pauseUntil = 0; saveDb();
      return send('▶ Jeda diakhiri. Perangkat anak bisa dipakai lagi.');
    case '/laporan': return send(laporanText());
    case '/status': return send(statusText());
    case '/kunci':
      db.policy.locked = true; queueCommand('lock'); saveDb();
      return send('🔒 Perintah *KUNCI* dikirim. HP anak akan terkunci dalam ±1 menit (atau langsung bila sedang online).');
    case '/buka':
      db.policy.locked = false; db.policy.scareActive = false; db.policy.pauseUntil = 0; queueCommand('unlock'); saveDb();
      return send('🔓 Kunci dibuka. HP anak bisa dipakai lagi.');
    case '/polisi': {
      if (!db.scareVideo) return send('🎬 Video polisinya belum ada. *Kirim dulu videonya ke chat ini*, setelah itu tombol ini langsung bisa dipakai.');
      db.policy.scareActive = true; queueCommand('scare'); saveDb();
      return send('🚨 *VIDEO POLISI DITAMPILKAN.* Dalam ±10 detik layar HP anak berubah jadi video itu dan terkunci di sana, sampai kamu tekan tombol *Matikan Video Polisi* (atau /buka).');
    }
    case '/polisimati':
      db.policy.scareActive = false; queueCommand('unscare'); saveDb();
      return send('✅ Video polisi dimatikan. HP anak kembali normal.');
    case '/blokir': {
      if (!arg) return send('Format: `/blokir com.contoh.aplikasi`\nNama paket bisa dilihat di /laporan versi lengkap atau tanya saya nama paket aplikasi tertentu.');
      if (!db.policy.blockedApps.includes(arg)) db.policy.blockedApps.push(arg);
      saveDb(); return send('🚫 Aplikasi `' + arg + '` diblokir. Akan tertutup otomatis setiap kali dibuka.');
    }
    case '/izin': {
      db.policy.blockedApps = db.policy.blockedApps.filter(x => x !== arg); saveDb();
      return send('✅ Blokir `' + arg + '` dicabut.');
    }
    case '/daftarblokir':
      return send('🚫 *Aplikasi diblokir:*\n' + (db.policy.blockedApps.length ? db.policy.blockedApps.map(x => '• `' + x + '`').join('\n') : '(kosong)'));
    case '/batas': {
      const n = parseInt(arg, 10); if (isNaN(n) || n < 0) return send(batasText());
      db.policy.dailyLimitMinutes = n; saveDb();
      return send(n === 0 ? '⏱ Batas total harian dihapus.' : '⏱ Batas total diatur: *' + fmtMin(n) + '/hari*. Lewat batas ini HP terkunci sampai besok.');
    }
    case '/batasapp': {
      const [pkg, menit] = rest; const n = parseInt(menit, 10);
      if (!pkg || isNaN(n)) return send('Format: `/batasapp <paket> <menit>`');
      if (n <= 0) delete db.policy.perAppLimits[pkg]; else db.policy.perAppLimits[pkg] = n;
      saveDb(); return send('⏱ Batas `' + pkg + '`: ' + (n <= 0 ? 'dihapus' : fmtMin(n) + '/hari'));
    }
    case '/jadwal': {
      const m = arg.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(.*)/);
      if (!m) return send(jadwalText());
      db.policy.schedules.push({ from: m[1].padStart(5, '0'), to: m[2].padStart(5, '0'), label: m[3] || '' }); saveDb();
      return send('🗓 Jadwal ditambah: *' + m[1] + '–' + m[2] + '* HP terkunci di jam ini setiap hari.');
    }
    case '/hapusjadwal':
      db.policy.schedules = []; saveDb(); return send('🗓 Semua jadwal kunci dihapus.');
    case '/presetanakkecil': {
      // Preset awal untuk anak ±7 tahun — semua nilai bisa diubah lagi sesudahnya.
      db.policy.dailyLimitMinutes = 60;
      const blokirKecil = ['com.zhiliaoapp.musically', 'com.instagram.android', 'com.facebook.katana', 'com.google.android.youtube'];
      for (const p of blokirKecil) if (!db.policy.blockedApps.includes(p)) db.policy.blockedApps.push(p);
      if (!db.policy.schedules.some(s => s.label === 'tidur malam')) db.policy.schedules.push({ from: '20:00', to: '05:30', label: 'tidur malam' });
      saveDb();
      return send('🧒 *Preset anak kecil (±7 tahun) diterapkan:*\n• Batas main total: *60 menit/hari* — ubah: `/batas 90`\n• Terblokir: TikTok, Instagram, Facebook, YouTube biasa — buka: `/izin <paket>`\n• Saran: izinkan *YouTube Kids* (`com.google.android.apps.youtube.kids`) sebagai pengganti YouTube\n• Kunci otomatis jam tidur: *20:00–05:30* — hapus: `/hapusjadwal`\n\nSemua ini hanya awalan, atur lagi sesuai kebiasaan anakmu.');
    }
    case '/videopolisi':
      return send(db.scareVideo
        ? '🎬 Video peringatan saat ini: *' + (db.scareVideo.fileName || 'video') + '* (diatur ' + new Date(db.scareVideo.setAt).toLocaleString('id-ID') + ').\nKirim video baru ke sini untuk menggantinya, atau /hapusvideo untuk mematikan.'
        : '🎬 Belum ada video peringatan.\n*Kirim saja sebuah video ke chat ini* (misalnya video polisi yang menyuruh berhenti main HP) — video itu otomatis jadi video yang muncul full-screen di HP anak setiap kali aplikasi dibatasi/dikunci.');
    case '/hapusvideo':
      db.scareVideo = null; saveDb();
      return send('🎬 Video peringatan dimatikan. Layar blokir kembali ke tampilan teks biasa.');
    case '/kode':
      return send('🔑 *Kode pairing aplikasi anak:* `' + CHILD_CODE + '`\nMasukkan kode ini + alamat server ini satu kali di aplikasi HP anak.');
    default:
      return send('Perintah tidak dikenal. Kirim /start untuk menu.');
  }
}

async function handleCallback(cb) {
  const fromId = cb.from && cb.from.id; const chatId = cb.message && cb.message.chat.id;
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!isParent(fromId)) return;
  const fake = { chat: { id: chatId }, from: cb.from, text: '' };
  const map = { menu: '/start', laporan: '/laporan', status: '/status', kunci: '/kunci', buka: '/buka', daftarblokir: '/daftarblokir', info_batas: '/batas', info_jadwal: '/jadwal', kode: '/kode', polisi: '/polisi', polisi_off: '/polisimati', taut: '/taut', matikan: '/matikan', timer: '/timer', jeda: '/jeda', timer_30: '/timer30', timer_60: '/timer60', timer_90: '/timer90', timer_120: '/timer120', timer_0: '/timer0', jeda_15: '/jeda15', jeda_30: '/jeda30', jeda_60: '/jeda60', jeda_off: '/jedabatal' };
  if (map[cb.data]) { fake.text = map[cb.data]; return handleCommand(fake); }
}

let offset = 0;
async function poll() {
  if (!BOT_TOKEN || BOT_TOKEN.includes('isi_token')) { console.log('[bot] BOT_TOKEN belum diisi, polling Telegram dilewati. API HP anak tetap jalan.'); return; }
  console.log('[bot] polling Telegram mulai...');
  while (true) {
    try {
      const data = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      if (data && data.ok) {
        for (const u of data.result || []) {
          offset = u.update_id + 1;
          if (u.message) handleCommand(u.message).catch(e => console.error(e));
          if (u.callback_query) handleCallback(u.callback_query).catch(e => console.error(e));
        }
      } else { await new Promise(r => setTimeout(r, 5000)); }
    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
  }
}

// ---------- HTTP API untuk aplikasi anak ----------
function readBody(req) {
  return new Promise(resolve => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function authed(req) { return (req.headers['x-child-code'] || '') === CHILD_CODE; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return json(res, 200, { ok: true, devices: Object.keys(db.devices).length });
  if (p.startsWith('/api/') && !authed(req)) return json(res, 401, { ok: false, error: 'kode pairing salah' });

  if (p === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const id = b.deviceId || crypto.createHash('sha1').update((b.model || '') + (b.deviceName || '') + CHILD_CODE).digest('hex').slice(0, 12);
    db.devices[id] = Object.assign({}, db.devices[id], { name: b.deviceName || 'HP Anak', model: b.model || '', android: b.androidVersion || '', lastSeen: now() });
    saveDb(); return json(res, 200, { ok: true, deviceId: id });
  }
  if (p === '/api/heartbeat' && req.method === 'POST') {
    const b = await readBody(req); const d = db.devices[b.deviceId]; if (!d) return json(res, 404, { ok: false });
    d.lastSeen = now(); if (b.battery != null) d.battery = b.battery; if (b.foregroundApp) d.foregroundApp = b.foregroundApp;
    saveDb(); return json(res, 200, { ok: true });
  }
  if (p === '/api/usage' && req.method === 'POST') {
    const b = await readBody(req); if (!db.devices[b.deviceId]) return json(res, 404, { ok: false });
    db.usage[b.deviceId] = { date: b.date, totalMinutes: b.totalMinutes || 0, apps: b.apps || [], receivedAt: now() };
    saveDb(); return json(res, 200, { ok: true });
  }
  if (p === '/api/alert' && req.method === 'POST') {
    const b = await readBody(req);
    const d = db.devices[b.deviceId];
    const text = '⚠ *ALERT dari HP anak' + (d ? ' (' + d.name + ')' : '') + '*\n' + (b.message || b.type || 'alert');
    for (const pid of PARENT_IDS) {
      tg('sendMessage', { chat_id: pid, parse_mode: 'Markdown', text }).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/policy' && req.method === 'GET') {
    const pol = Object.assign({}, db.policy, { hasScareVideo: !!db.scareVideo, scareVideoSetAt: db.scareVideo ? db.scareVideo.setAt : 0 });
    return json(res, 200, { ok: true, policy: pol });
  }
  if (p === '/api/scare-video' && req.method === 'GET') {
    // Server meneruskan video dari Telegram ke HP anak (token bot TIDAK dibagikan ke aplikasi).
    if (!db.scareVideo || !db.scareVideo.fileId) return json(res, 404, { ok: false, error: 'belum ada video peringatan' });
    if (!BOT_TOKEN || BOT_TOKEN.includes('isi_token')) return json(res, 503, { ok: false, error: 'token bot belum diisi' });
    try {
      const info = await tg('getFile', { file_id: db.scareVideo.fileId });
      const filePath = info && info.result && info.result.file_path;
      if (!filePath) return json(res, 502, { ok: false, error: 'file tidak ditemukan di Telegram' });
      const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
      if (!fileRes.ok) return json(res, 502, { ok: false, error: 'gagal mengambil video' });
      res.writeHead(200, { 'content-type': fileRes.headers.get('content-type') || 'video/mp4' });
      const buf = Buffer.from(await fileRes.arrayBuffer());
      return res.end(buf);
    } catch (e) { return json(res, 502, { ok: false, error: 'gagal mengambil video' }); }
  }
  if (p === '/api/commands' && req.method === 'GET') {
    const did = url.searchParams.get('deviceId');
    const pending = db.commands.filter(c => !c.delivered && (c.deviceId === '*' || c.deviceId === did));
    pending.forEach(c => { c.delivered = true; }); saveDb();
    return json(res, 200, { ok: true, commands: pending });
  }
  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => console.log('[server] jalan di port ' + PORT + ' | parent: ' + (PARENT_IDS.length ? PARENT_IDS.join(',') : '(belum diisi)') + ' | kode pairing aktif'));
poll();
