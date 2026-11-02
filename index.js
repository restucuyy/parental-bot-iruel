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
  targetDevice: '*',
  featureTargets: {}, // fitur -> deviceId | '*' (pilihan device terakhir per fitur)
  lastBotMsg: {},    // chatId -> message_id pesan bot terakhir (agar yang lama otomatis dihapus, tidak menimbun)
  perDevice: {},      // deviceId -> {dailyLimitMinutes?, pauseUntil?} aturan khusus per HP
  devices: {},        // deviceId -> {name, model, android, lastSeen, battery, foregroundApp}
  usage: {},          // deviceId -> {date, totalMinutes, apps:[{package,label,minutes}], receivedAt}
  policy: {           // satu kebijakan untuk semua HP anak (v1)
    locked: false,
    scareActive: false,            // true = layar HP anak sedang menampilkan video peringatan (polisi)
    pauseUntil: 0,                 // JEDA PERANGKAT: epoch ms sampai kapan perangkat dijeda total
    dailyLimitMinutes: 0,          // 0 = tanpa batas
    sessionUntil: 0,               // sesi timer: epoch ms berakhirnya sesi (0 = tidak ada sesi)
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
function queueCommand(type, payload, devId) {
  const cmd = { id: crypto.randomBytes(4).toString('hex'), deviceId: devId || '*', type, payload: payload || {}, createdAt: now(), delivered: false };
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
    [{ text: '\📱 DEVICE', callback_data: 'device' }, { text: '\📊 Laporan', callback_data: 'laporan' }],
    [{ text: 'TIMER PERANGKAT', callback_data: 'timer' }],
    [{ text: 'JEDA PERANGKAT', callback_data: 'jeda' }],
    [{ text: 'TAUT HP', callback_data: 'taut' }, { text: '\📱 Status HP', callback_data: 'status' }],
    [{ text: '\🚨 VIDEO POLISI', callback_data: 'polisi' }],
    [{ text: '\u2705 Matikan Video Polisi', callback_data: 'polisi_off' }, { text: '\🔒 Kunci HP', callback_data: 'kunci' }],
    [{ text: '\🔓 Buka Kunci', callback_data: 'buka' }, { text: '\🚫 Daftar Blokir', callback_data: 'daftarblokir' }],
    [{ text: '\u23f1 Batas Waktu', callback_data: 'info_batas' }, { text: '\🗓 Jadwal Kunci', callback_data: 'info_jadwal' }],
    [{ text: '\🔑 Kode Pairing', callback_data: 'kode' }]
  ]
};

// ---------- Rich Message (tabel asli + button kapsul di badan pesan) ----------
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Kapsul Rich lebarnya mengikuti teks — samakan panjang label sepasang dengan
// spasi non-breaking di kiri/kanan agar tombol tampil simetris (pilihan user).
const W_UP = { A: .98, B: 1.0, C: 1.08, D: 1.08, E: .89, F: .82, G: 1.08, H: 1.06, I: .39, J: .71, K: .95, L: .82, M: 1.26, N: 1.06, O: 1.09, P: .95, Q: 1.09, R: .95, S: .89, T: .89, U: 1.06, V: .98, W: 1.39, X: .95, Y: .95, Z: .89 };
const W_LO = { a: .82, b: .89, c: .74, d: .89, e: .82, f: .43, g: .89, h: .89, i: .35, j: .35, k: .79, l: .35, m: 1.32, n: .89, o: .89, p: .89, q: .89, r: .51, s: .74, t: .51, u: .89, v: .79, w: 1.14, x: .79, y: .79, z: .74 };
function charW(ch) {
  if (ch === ' ' || ch === '\u00A0') return 0.37;
  if (W_UP[ch]) return W_UP[ch];
  if (W_LO[ch]) return W_LO[ch];
  if (ch >= '0' && ch <= '9') return 0.89;
  const cp = ch.codePointAt(0);
  if (cp > 0x2000) return 1.7;
  return 0.85;
}
function textW(t) { let w = 0; for (const ch of String(t)) w += charW(ch); return w; }
function padLabel(text, target) {
  const t = String(text);
  const w = textW(t);
  if (w >= target) return t;
  const n = Math.ceil((target - w) / 0.37);
  const left = Math.round(n * 0.30);
  return '\u00A0'.repeat(left) + t + '\u00A0'.repeat(n - left);
}
function targetName() { return (!db.targetDevice || db.targetDevice === '*') ? 'Semua HP' : ((db.devices[db.targetDevice] || {}).name || 'Semua HP'); }
function startRichHtml() {
  const id = firstDeviceId(); const d = id ? db.devices[id] : null; const p = db.policy;
  const status = !d ? 'Belum tertaut' : (deviceOnline(d) ? 'Online' : 'Offline');
  const devs = Object.values(db.devices);
  const devList = devs.length ? devs.map(x => x.name + ' (' + (deviceOnline(x) ? 'Online' : 'Offline') + ')').join(', ') : 'Belum ada';
  const jeda = p.pauseUntil && p.pauseUntil > now() ? 'Dijeda s/d ' + new Date(p.pauseUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : 'Tidak dijeda';
  return ''
    + '<p><b>Selamat Datang di Parental Control</b></p>'
    + '<blockquote>Halo Ayah/Bunda. Dari sini Anda mengendalikan HP anak: tautkan perangkat, matikan layar, atur timer bermain, dan jeda perangkat kapan pun perlu. Satu tombol darurat di paling atas: <b>VIDEO POLISI</b>, sekali tekan layar HP anak langsung menampilkannya.</blockquote>'
    + '<table bordered striped>'
    + '<tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Perangkat Anak</td><td>' + esc(devList) + '</td></tr>'
    + '<tr><td>Status</td><td>' + esc(status) + (d && d.battery != null ? ' · Baterai ' + d.battery + '%' : '') + '</td></tr>'
    + '<tr><td>Timer Hari Ini</td><td>' + (p.dailyLimitMinutes ? fmtMin(p.dailyLimitMinutes) + ' / hari' : 'Tanpa batas') + '</td></tr>'
    + '<tr><td>Jeda Perangkat</td><td>' + esc(jeda) + '</td></tr>'
    + '<tr><td>Video Polisi</td><td>' + (db.scareVideo ? 'Siap dipakai' : 'Belum dipasang (kirim video ke bot ini)') + '</td></tr>'
    + '<tr><td>Layar Terkunci</td><td>' + (p.locked ? 'Ya' : 'Tidak') + '</td></tr>'
    + '</table>'
    // Tata letak user (15:31): DEVICE+LAPORAN pasangan; TIMER sendiri;
    // JEDA sendiri; TAUT HP+STATUS HP pasangan; VIDEO POLISI sendiri.
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="device">' + padLabel('DEVICE', 21) + '</tg-button><tg-button type="callback_data" style="primary" data="laporan">' + padLabel('Laporan', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="timer">' + padLabel('TIMER PERANGKAT', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="jeda">' + padLabel('JEDA PERANGKAT', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="taut">' + padLabel('TAUT HP', 21) + '</tg-button><tg-button type="callback_data" style="success" data="status">' + padLabel('Status HP', 21) + '</tg-button></tg-button-row>'
    + (polisiActive()
      ? '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="pmatikan">' + padLabel('MATIKAN VIDEO', 44) + '</tg-button></tg-button-row>'
      : '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="polisi">' + padLabel('\uD83D\uDEA8 VIDEO POLISI', 44) + '</tg-button></tg-button-row>');
}
function deviceRichHtml() {
  const ids = Object.keys(db.devices);
  return '<p><b>DEVICE</b></p>'
    + '<blockquote>Kelola HP anak yang tertaut ke bot ini: tambah HP baru, lepas HP, atau lihat daftarnya.</blockquote>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Jumlah Tertaut</td><td>' + ids.length + ' HP</td></tr>'
    + (ids.length ? ids.map(id => { const d = db.devices[id]; return '<tr><td>' + esc(d.name) + '</td><td>' + (deviceOnline(d) ? 'Online' : 'Offline') + '</td></tr>'; }).join('') : '<tr><td>Perangkat</td><td>Belum ada</td></tr>')
    + '</table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="dev_add">' + padLabel('+ DEVICE', 21) + '</tg-button><tg-button type="callback_data" style="danger" data="dev_del">' + padLabel('- DEVICE', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="dev_list">' + padLabel('LIST DEVICE', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="matikan">' + padLabel('MATIKAN HP', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}

function ftTarget(fitur) { const t = (db.featureTargets || {})[fitur]; return t || '*'; }
function ftTargetName(fitur) { const t = ftTarget(fitur); return t === '*' ? 'Semua HP' : ((db.devices[t] || {}).name || 'Semua HP'); }
function polisiRichHtml() {
  return '<p><b>VIDEO POLISI</b></p>'
    + '<blockquote>Video peringatan yang tampil full-screen di HP anak dan terkunci di sana sampai kamu buka lagi. Videonya sudah paten \u2014 video kiriman kamu.</blockquote>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Video</td><td>' + (db.scareVideo ? 'PATEN \u2014 ' + esc(db.scareVideo.fileName || 'video') + ' (video kiriman kamu, tidak bisa diganti / dihapus)' : 'PATEN \u2014 video bawaan aplikasi (video kiriman kamu, tertanam di aplikasi)') + '</td></tr>'
    + '<tr><td>Status</td><td>' + (polisiActive() ? 'SEDANG TAMPIL di HP anak (terkunci)' : 'Tidak aktif') + '</td></tr></table>'
    + (polisiActive()
      ? '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="pmatikan">' + padLabel('MATIKAN VIDEO', 44) + '</tg-button></tg-button-row>'
      : '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="pstart">' + padLabel('START VIDEO', 44) + '</tg-button></tg-button-row>')
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}
function fiturRichHtml(fitur) {
  const label = FITUR_LABEL[fitur] || fitur;
  const info = fitur === 'matikan' ? 'Urutan di HP anak: video polisi tampil \u00b120 detik dulu, baru layar mati & terkunci.'
    : fitur === 'kunci' ? 'HP anak langsung terkunci ke layar blokir sampai kamu buka lagi.'
    : 'Membuka kunci, menghentikan video polisi, dan mengakhiri jeda pada device tujuan.';
  return '<p><b>' + esc(label) + '</b></p>'
    + '<blockquote>' + info + '</blockquote>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Device Tujuan</td><td>' + esc(ftTargetName(fitur)) + '</td></tr></table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="fstart_' + fitur + '">' + padLabel(label + ' SEKARANG', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="fpilih_' + fitur + '">' + padLabel('PILIH DEVICE', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}
function pickTargetRichHtml(fitur, prefix) {
  const ids = Object.keys(db.devices);
  let btns = ''; // tombol Semua HP dihapus atas perintah user: hanya HP tertaut yang ditampilkan
  for (let i = 0; i < ids.length; i += 2) {
    btns += '<tg-button-row align="center">';
    btns += '<tg-button type="callback_data" style="success" data="' + prefix + '_' + ids[i] + '">' + padLabel(esc(db.devices[ids[i]].name), 21) + '</tg-button>';
    if (ids[i + 1]) btns += '<tg-button type="callback_data" style="success" data="' + prefix + '_' + ids[i + 1] + '">' + padLabel(esc(db.devices[ids[i + 1]].name), 21) + '</tg-button>';
    btns += '</tg-button-row>';
  }
  btns += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return '<p><b>' + esc(FITUR_LABEL[fitur] || fitur) + ' \u2014 PILIH DEVICE</b></p>'
    + '<blockquote>Pilih device tujuan fitur ini. Pilihanmu diingat untuk tombol START berikutnya.</blockquote>'
    + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
    + btns;
}
const FITUR_LABEL = { polisi: 'VIDEO POLISI', polisi_off: 'MATIKAN VIDEO POLISI', matikan: 'MATIKAN HP', kunci: 'KUNCI HP', buka: 'BUKA KUNCI' };
function deviceRowsHtml() {
  const ids = Object.keys(db.devices);
  if (!ids.length) return '<tr><td colspan="2">Belum ada HP anak yang tertaut</td></tr>';
  return ids.map(id => { const d = db.devices[id]; return '<tr><td>' + esc(d.name) + '</td><td>' + (deviceOnline(d) ? 'Online' : 'Offline') + (d.battery != null ? ' \u00b7 Baterai ' + d.battery + '%' : '') + '</td></tr>'; }).join('');
}
function tautRichHtml() {
  const ids = Object.keys(db.devices);
  const d = ids.length ? db.devices[ids[0]] : null;
  return '<p><b>TAUT HP</b></p>'
    + '<blockquote>Cara menautkan: tekan GENERATE KODE \u2014 muncul kode acak sekali pakai. Ketik kode itu di aplikasi HP anak, HP langsung tertaut dan kodenya hangus (tidak bisa dipakai lagi). Buat kode baru untuk HP berikutnya.</blockquote>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Status</td><td>' + (d ? (deviceOnline(d) ? 'Tertaut & online \u2014 ' + esc(d.name) : 'Tertaut, sedang offline \u2014 ' + esc(d.name)) : 'Belum ada HP yang tertaut') + '</td></tr>'
    + '<tr><td>Kode sekali pakai</td><td>' + (activePairCode() ? '<b>' + activePairCode() + '</b> (berlaku 15 menit, hangus sesudah dipakai)' : 'belum dibuat \u2014 tekan GENERATE KODE') + '</td></tr>'
    + '<tr><td>HP tertaut</td><td>' + ids.length + '</td></tr></table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="tautgen">' + padLabel('GENERATE KODE', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}
function listDeviceRichHtml() {
  return '<p><b>LIST DEVICE</b></p>'
    + '<blockquote>Semua HP anak yang tertaut ke bot ini. Satu kode pairing yang sama bisa dipakai di banyak HP.</blockquote>'
    + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}
function pickDeviceRichHtml(fitur) {
  const ids = Object.keys(db.devices);
  let btns = '';
  for (let i = 0; i < ids.length; i += 2) {
    btns += '<tg-button-row align="center">';
    btns += '<tg-button type="callback_data" style="success" data="act_' + fitur + '_' + ids[i] + '">' + padLabel(esc(db.devices[ids[i]].name), 21) + '</tg-button>';
    if (ids[i + 1]) btns += '<tg-button type="callback_data" style="success" data="act_' + fitur + '_' + ids[i + 1] + '">' + padLabel(esc(db.devices[ids[i + 1]].name), 21) + '</tg-button>';
    btns += '</tg-button-row>';
  }
  btns += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return '<p><b>' + esc(FITUR_LABEL[fitur] || fitur) + ' — PILIH DEVICE</b></p>'
    + '<blockquote>Perintah ini dikirim ke HP yang kamu pilih di bawah, atau ke semua HP sekaligus.</blockquote>'
    + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
    + btns;
}
function delDeviceRichHtml() {
  const ids = Object.keys(db.devices);
  let btns = '';
  for (let i = 0; i < ids.length; i += 2) {
    btns += '<tg-button-row align="center">';
    btns += '<tg-button type="callback_data" style="danger" data="del_' + ids[i] + '">' + padLabel(esc(db.devices[ids[i]].name), 21) + '</tg-button>';
    if (ids[i + 1]) btns += '<tg-button type="callback_data" style="danger" data="del_' + ids[i + 1] + '">' + padLabel(esc(db.devices[ids[i + 1]].name), 21) + '</tg-button>';
    btns += '</tg-button-row>';
  }
  btns += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return '<p><b>- DEVICE — HAPUS PERANGKAT</b></p>'
    + '<blockquote>Tekan nama HP untuk melepasnya dari bot ini. Bila aplikasinya di HP itu masih terpasang dan aktif, HP bisa tertaut lagi — hapus juga aplikasinya di HP anak untuk melepas total.</blockquote>'
    + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
    + btns;
}
function timerRichHtml() {
  const p = db.policy;
  const sisaSesi = p.sessionUntil && p.sessionUntil > now() ? Math.ceil((p.sessionUntil - now()) / 60000) : 0;
  let rows = '<tr><td>Sesi Berjalan</td><td>' + (sisaSesi ? 'Sisa \u00b1' + sisaSesi + ' menit' : (p.sessionUntil ? 'Sudah habis \u2014 HP terkunci' : 'Tidak ada sesi')) + '</td></tr>';
  rows += '<tr><td>Batas Harian</td><td>' + (p.dailyLimitMinutes ? fmtMin(p.dailyLimitMinutes) + ' / hari' : 'Tanpa batas') + '</td></tr>';
  for (const id of Object.keys(db.perDevice || {})) {
    const pd = db.perDevice[id];
    if (!pd) continue;
    const nm = (db.devices[id] || {}).name || id;
    if (Object.prototype.hasOwnProperty.call(pd, 'sessionUntil')) rows += '<tr><td>Sesi ' + esc(nm) + '</td><td>' + (pd.sessionUntil > now() ? 'Sisa \u00b1' + Math.ceil((pd.sessionUntil - now()) / 60000) + ' menit' : (pd.sessionUntil ? 'Sudah habis' : 'Tidak ada sesi')) + '</td></tr>';
    if (Object.prototype.hasOwnProperty.call(pd, 'dailyLimitMinutes')) rows += '<tr><td>Batas ' + esc(nm) + '</td><td>' + (pd.dailyLimitMinutes ? fmtMin(pd.dailyLimitMinutes) + ' / hari' : 'Mati') + '</td></tr>';
  }
  return ''
    + '<p><b>TIMER PERANGKAT</b></p>'
    + '<blockquote>Pilih lama sesinya dulu, lalu pilih HP-nya. Di HP anak muncul bubble hitung mundur menit:detik; begitu habis, HP langsung mati dan terkunci \u2014 dibuka lagi hanya bisa dari bot ini.</blockquote>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>' + rows + '</table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="tset_5">' + padLabel('5 MENIT', 21) + '</tg-button><tg-button type="callback_data" style="primary" data="tset_10">' + padLabel('10 MENIT', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="tset_20">' + padLabel('20 MENIT', 21) + '</tg-button><tg-button type="callback_data" style="primary" data="tset_30">' + padLabel('30 MENIT', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="tset_0">' + padLabel('MATIKAN TIMER', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="info_jadwal">' + padLabel('JADWAL KUNCI', 21) + '</tg-button><tg-button type="callback_data" style="success" data="presetkecil">' + padLabel('PRESET ANAK KECIL', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}
function pickAfterHtml(kind, n) {
  const isTimer = kind === 'timer';
  const title = isTimer ? (n === 0 ? 'MATIKAN TIMER' : 'TIMER ' + n + ' MENIT') : (n === 0 ? 'AKHIRI JEDA' : 'JEDA ' + n + ' MENIT');
  const prefix = (isTimer ? 'tgo_' : 'jgo_') + n + '_';
  let btns = '';
  for (const id of Object.keys(db.devices)) {
    btns += '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="' + prefix + id + '">' + padLabel(esc(db.devices[id].name), 44) + '</tg-button></tg-button-row>';
  }
  btns += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="' + (isTimer ? 'timer' : 'jeda') + '">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return '<p><b>' + title + ' \u2014 PILIH DEVICE</b></p>'
    + '<blockquote>Pilih HP yang mau dipasangi ' + (isTimer ? 'timer' : 'jeda') + ' ini, atau semua HP sekaligus.</blockquote>'
    + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
    + btns;
}
function jedaRichHtml() {
  const p = db.policy;
  const sisa = p.pauseUntil && p.pauseUntil > now() ? Math.ceil((p.pauseUntil - now()) / 60000) : 0;
  return ''
    + '<p><b>JEDA PERANGKAT</b></p>'
    + '<blockquote>Pilih lama jedanya dulu, sesudah itu baru pilih HP-nya. Selama jeda, semua aplikasi di HP anak tertutup.</blockquote>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Jeda Umum</td><td>' + (sisa ? 'Sedang dijeda \u00b1' + sisa + ' menit lagi' : 'Tidak dijeda') + '</td></tr></table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="jset_15">' + padLabel('15 MENIT', 21) + '</tg-button><tg-button type="callback_data" style="success" data="jset_30">' + padLabel('30 MENIT', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="jset_60">' + padLabel('60 MENIT', 21) + '</tg-button><tg-button type="callback_data" style="success" data="jset_120">' + padLabel('120 MENIT', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="jset_0">' + padLabel('AKHIRI JEDA', 44) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}
function toRichHtml(text) {
  const lines = String(text || '').split('\n');
  let html = ''; let rows = []; let quote = [];
  const flushRows = () => { if (rows.length) { html += '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>' + rows.join('') + '</table>'; rows = []; } };
  const flushQuote = () => { if (quote.length) { html += '<blockquote>' + quote.join('<br/>') + '</blockquote>'; quote = []; } };
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) { flushQuote(); continue; }
    const plain = esc(line.replace(/\*/g, '').replace(/`/g, ''));
    const bold = line.match(/^\*(.+)\*$/);
    if (bold && !line.includes(':')) { flushRows(); flushQuote(); html += '<p><b>' + esc(bold[1]) + '</b></p>'; continue; }
    const kv = plain.match(/^([^:\u2022\-]{2,32}):\s+(.+)$/);
    if (kv) { flushQuote(); rows.push('<tr><td>' + esc(kv[1].trim()) + '</td><td>' + esc(kv[2]) + '</td></tr>'); continue; }
    if (/^[\u2022\-]\s+/.test(line)) {
      flushQuote();
      const item = plain.replace(/^[\u2022\-]\s+/, '');
      const parts = item.split(/\s+\u2014\s+/);
      if (parts.length > 1) rows.push('<tr><td>' + esc(parts[0]) + '</td><td>' + esc(parts.slice(1).join(' \u2014 ')) + '</td></tr>');
      else rows.push('<tr><td colspan="2">' + esc(item) + '</td></tr>');
      continue;
    }
    if (/^\d+\.\s+/.test(line)) { flushQuote(); rows.push('<tr><td colspan="2">' + plain + '</td></tr>'); continue; }
    quote.push(plain);
  }
  flushRows(); flushQuote();
  return html || ('<blockquote>' + esc(String(text || '')) + '</blockquote>');
}

async function sendRich(chatId, html, fallbackText, useMenu) {
  let r = null;
  try {
    r = await tg('sendRichMessage', { chat_id: chatId, rich_message: { html } });
    if (!(r && r.ok)) r = null;
  } catch (e) { r = null; }
  if (!r) r = await tg('sendMessage', { chat_id: chatId, parse_mode: 'Markdown', text: fallbackText, reply_markup: useMenu === false ? undefined : MENU });
  // Satu pesan hidup per chat: pesan bot baru menghapus pesan bot sebelumnya (perintah user 2026-11-02: jangan menimbun)
  try {
    const newId = r && ((r.result && (r.result.message_id || (r.result.message && r.result.message.message_id))) || r.message_id);
    if (newId) {
      if (!db.lastBotMsg) db.lastBotMsg = {};
      const prev = db.lastBotMsg[chatId];
      db.lastBotMsg[chatId] = newId;
      saveDb();
      if (prev && prev !== newId) tg('deleteMessage', { chat_id: chatId, message_id: prev }).catch(() => {});
    }
  } catch (e) {}
  return r;
}

function laporanText() {
  const ids = Object.keys(db.devices); if (!ids.length) return 'Belum ada HP anak yang terhubung.\nInstall aplikasi anak dulu, lalu masukkan kode pairing.';
  const out = [];
  for (const id of ids) {
    const u = db.usage[id]; const d = db.devices[id];
    if (!u) { out.push('📊 *Laporan — ' + d.name + '*\nBelum ada laporan pemakaian (masuk tiap ±5 menit).'); continue; }
    let t = '📊 *Laporan pemakaian — ' + d.name + '*\nTanggal: ' + u.date + '\nTotal: ' + fmtMin(u.totalMinutes) + '\n';
    const apps = (u.apps || []).slice().sort((a, b) => b.minutes - a.minutes).slice(0, 10);
    for (const a of apps) t += '• ' + (a.label || a.package) + ' — ' + fmtMin(a.minutes) + '\n';
    out.push(t);
  }
  return out.join('\n');
}
function statusText() {
  const ids = Object.keys(db.devices); if (!ids.length) return 'Belum ada HP anak yang terhubung.';
  const out = ['📱 *Status HP anak*'];
  for (const id of ids) {
    const d = db.devices[id];
    out.push('Nama: ' + d.name + '\nModel: ' + (d.model || '-') + ' (Android ' + (d.android || '-') + ')\nStatus: ' + (deviceOnline(d) ? 'Online' : 'Offline (terakhir ' + new Date(d.lastSeen || 0).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ')') + '\nBaterai: ' + (d.battery != null ? d.battery + '%' : '-') + '\nAplikasi terbuka: ' + (d.foregroundApp || '-') + '\nTerkunci: ' + (db.policy.locked ? 'Ya' : 'Tidak'));
  }
  return out.join('\n');
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


function statusRichHtml() {
  let html = '<p><b>STATUS HP</b></p>' + toRichHtml(statusText());
  html += '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="kunci">' + padLabel('KUNCI HP', 21) + '</tg-button><tg-button type="callback_data" style="success" data="buka">' + padLabel('BUKA KUNCI', 21) + '</tg-button></tg-button-row>';
  html += '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="lokasi">' + padLabel('MINTA LOKASI', 21) + '</tg-button>' + (bunyiActive() ? '<tg-button type="callback_data" style="success" data="bunyimati">' + padLabel('MATIKAN BUNYI', 21) + '</tg-button>' : '<tg-button type="callback_data" style="danger" data="bunyi">' + padLabel('BUNYIKAN HP', 21) + '</tg-button>') + '</tg-button-row>';
  html += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return html;
}
function topApps() {
  const id = firstDeviceId(); if (!id) return [];
  const u = db.usage[id]; if (!u) return [];
  return (u.apps || []).slice().sort((a, b) => b.minutes - a.minutes).slice(0, 5);
}
function laporanRichHtml() {
  let html = '<p><b>LAPORAN PEMAKAIAN</b></p>' + toRichHtml(laporanText());
  const apps = topApps();
  if (apps.length) {
    html += '<blockquote>Tekan nama aplikasi untuk memblokirnya atau mengatur batas waktunya.</blockquote>';
    for (const a of apps) html += '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="app_' + esc(a.package) + '">' + padLabel(esc(a.label || a.package), 44) + '</tg-button></tg-button-row>';
  }
  html += '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="daftarblokir">' + padLabel('DAFTAR BLOKIR', 44) + '</tg-button></tg-button-row>';
  html += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return html;
}
function appRichHtml(pkg) {
  const apps = topApps();
  const a = apps.find(x => x.package === pkg);
  const label = a ? (a.label || pkg) : pkg;
  const blocked = db.policy.blockedApps.includes(pkg);
  const lim = (db.policy.perAppLimits || {})[pkg];
  return '<p><b>' + esc(label) + '</b></p>'
    + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
    + '<tr><td>Paket</td><td>' + esc(pkg) + '</td></tr>'
    + '<tr><td>Status</td><td>' + (blocked ? 'Diblokir' : 'Diizinkan') + '</td></tr>'
    + '<tr><td>Batas Waktu</td><td>' + (lim ? fmtMin(lim) + ' / hari' : 'Ikut timer umum') + '</td></tr></table>'
    + '<tg-button-row align="center">' + (blocked
      ? '<tg-button type="callback_data" style="success" data="appunblk_' + esc(pkg) + '">' + padLabel('IZINKAN', 44) + '</tg-button>'
      : '<tg-button type="callback_data" style="danger" data="appblok_' + esc(pkg) + '">' + padLabel('BLOKIR', 44) + '</tg-button>') + '</tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="applimit_' + esc(pkg) + '_30">' + padLabel('BATAS 30 MENIT', 21) + '</tg-button><tg-button type="callback_data" style="primary" data="applimit_' + esc(pkg) + '_60">' + padLabel('BATAS 60 MENIT', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="applimit_' + esc(pkg) + '_0">' + padLabel('HAPUS BATAS', 21) + '</tg-button><tg-button type="callback_data" style="link" data="laporan">' + padLabel('Kembali', 21) + '</tg-button></tg-button-row>';
}
function daftarBlokirRichHtml() {
  const list = db.policy.blockedApps || [];
  let rows = list.length ? list.map(x => '<tr><td>' + esc(x) + '</td><td>Diblokir</td></tr>').join('') : '<tr><td colspan="2">Belum ada aplikasi yang diblokir</td></tr>';
  let html = '<p><b>DAFTAR BLOKIR</b></p>'
    + '<blockquote>Blokir aplikasi baru dari tombol LAPORAN, lalu tekan nama aplikasinya. Tekan IZINKAN di bawah untuk membuka blokir.</blockquote>'
    + '<table bordered striped><tr><th>APLIKASI</th><th>KETERANGAN</th></tr>' + rows + '</table>';
  for (const x of list) html += '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="unblk_' + esc(x) + '">' + padLabel('Izinkan ' + x, 44) + '</tg-button></tg-button-row>';
  html += '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
  return html;
}
function jadwalRichHtml() {
  const list = db.policy.schedules || [];
  let rows = list.length ? list.map((x, i) => '<tr><td>' + (i + 1) + '. ' + esc(x.from) + '\u2013' + esc(x.to) + '</td><td>' + esc(x.label || 'Kunci otomatis') + '</td></tr>').join('') : '<tr><td colspan="2">Belum ada jadwal</td></tr>';
  return '<p><b>JADWAL KUNCI</b></p>'
    + '<blockquote>HP anak terkunci otomatis pada jam-jam ini setiap hari. Tekan jadwal siap pakai untuk menambah.</blockquote>'
    + '<table bordered striped><tr><th>JADWAL</th><th>KETERANGAN</th></tr>' + rows + '</table>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="sch_belajar">' + padLabel('19:00-21:00 Belajar', 21) + '</tg-button><tg-button type="callback_data" style="primary" data="sch_tidur">' + padLabel('20:00-05:30 Tidur', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="sch_sekolah">' + padLabel('07:00-13:00 Sekolah', 21) + '</tg-button><tg-button type="callback_data" style="danger" data="schdel">' + padLabel('Hapus Semua', 21) + '</tg-button></tg-button-row>'
    + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
}


// BUKA TOTAL (aturan user): sekali BUKA, semua yang aktif hilang bersamaan:
// kunci manual, video polisi, jeda, dan timer sesi — global maupun per-device.
function clearAllLocks() {
  db.polisiOn = {}; db.bunyiOnAt = 0;
  db.policy.locked = false; db.policy.scareActive = false; db.policy.pauseUntil = 0; db.policy.sessionUntil = 0;
  for (const id of Object.keys(db.perDevice || {})) { const d = db.perDevice[id]; if (d) { delete d.locked; delete d.scareActive; delete d.pauseUntil; delete d.sessionUntil; } }
  queueCommand('unscare', null, '*'); queueCommand('unlock', null, '*');
}
function setTargetLocked(target, val) {
  db.perDevice = db.perDevice || {};
  if (target === '*' || target === 'all') {
    db.policy.locked = val;
    if (!val) for (const id of Object.keys(db.perDevice)) { if (db.perDevice[id]) delete db.perDevice[id].locked; }
  } else if (val) {
    db.perDevice[target] = db.perDevice[target] || {};
    db.perDevice[target].locked = true;
  } else if (db.perDevice[target]) delete db.perDevice[target].locked;
}
function polisiStart(target) {
  // VIDEO POLISI versi remot penuh: video tampil dulu, sesudah itu HP mati & terkunci
  // sampai orang tua menekan BUKA dari bot.
  setTargetLocked(target, true);
  db.polisiOn = db.polisiOn || {};
  if (target === 'all' || target === '*') { db.polisiOn['*'] = now(); for (const id of Object.keys(db.devices)) db.polisiOn[id] = now(); }
  else db.polisiOn[target] = now();
  queueCommand('matikan', null, target === 'all' ? '*' : target);
  saveDb();
}
function polisiActive() { return !!(db.polisiOn && Object.keys(db.polisiOn).length); }
function bunyiActive() { return !!(db.bunyiOnAt && now() - db.bunyiOnAt < 40000); }

async function handleCommand(msg) {
  const chatId = msg.chat.id; const fromId = msg.from && msg.from.id;
  const text = (msg.text || '').trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase(); const arg = rest.join(' ');

  if (cmd === '/start') {
    if (!isParent(fromId)) {
      return sendRich(chatId, '<p><b>Bot Parental — Khusus Orang Tua</b></p><table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr><tr><td>ID Telegram kamu</td><td>' + esc(fromId) + '</td></tr><tr><td>Caranya</td><td>Masukkan ID itu ke PARENT_IDS di file .env server, lalu restart bot</td></tr></table>', 'Bot parental ini khusus orang tua.', false);
    }
    return sendRich(chatId, startRichHtml(), '👨‍👩‍👧 *Parental Control*\nTombol paling atas adalah tombol daruratmu: *satu kali tekan, layar HP anak langsung jadi video polisi* dan terkunci di sana sampai kamu matikan.\n\nPilih menu di bawah, atau pakai perintah:\n/laporan /status /kunci /buka\n/blokir <paket> /izin <paket>\n/batas <menit> /batasapp <paket> <menit>\n/jadwal <HH:MM-HH:MM> <label>\n/videopolisi — video yang muncul saat HP dibatasi (atau kirim video langsung ke sini)');
  }
  if (!isParent(fromId)) return sendRich(chatId, '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr><tr><td>Akses</td><td>Menu ini khusus orang tua yang terdaftar</td></tr></table>', 'Maaf, menu ini khusus orang tua yang terdaftar.', false);

  const send = (t, extra) => sendRich(chatId, toRichHtml(t), t);
  const setTimerCmd = (n) => { db.policy.dailyLimitMinutes = n; saveDb(); return send('◷ *TIMER PERANGKAT diatur: ' + (n === 0 ? 'tanpa batas' : fmtMin(n) + ' / hari') + '.*\nLewat dari itu, perangkat anak terkunci sampai besok.'); };
  const setJedaCmd = (mnt) => {
    db.policy.pauseUntil = now() + mnt * 60000; queueCommand('pause'); saveDb();
    return send('⏸ *PERANGKAT DIJEDA ' + mnt + ' menit* (s/d ' + new Date(db.policy.pauseUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ').\nSemua aplikasi tertutup selama jeda. Akhiri lebih awal dengan tombol Jedanya lagi lalu pilih Akhiri Jeda, atau /buka.');
  };

  // Orang tua mengirim video apa pun ke bot = video itu jadi video peringatan
  // yang diputar full-screen di HP anak setiap kali aplikasi dibatasi/dikunci.
  const vid = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (vid && vid.file_id) {
    if (db.scareVideo) return send('🎬 Video polisi sudah *PATEN* (video yang kamu kirim). Sesuai perintahmu, video tidak bisa diganti atau dihapus.');
    db.scareVideo = { fileId: vid.file_id, fileName: vid.file_name || 'video-peringatan.mp4', setAt: now() };
    saveDb();
    return send('🎬 Video peringatan *tersimpan sebagai video paten*. Video ini yang muncul full-screen di HP anak setiap kali dibatasi/dikunci, dan tidak bisa diganti atau dihapus.');
  }
  switch (cmd) {
    case '/taut': {
      const id = firstDeviceId(); const d = id ? db.devices[id] : null;
      return sendRich(chatId, tautRichHtml(), 'Menu TAUT HP.');
    }
    case '/lokasi': {
      const idsL = Object.keys(db.devices);
      if (!idsL.length) return send('Belum ada HP anak yang tertaut.');
      queueCommand('lokasi', null, idsL.length === 1 ? idsL[0] : '*'); saveDb();
      return send('\uD83D\uDCCD *LOKASI diminta* \u2014 titik lokasi HP anak dikirim ke chat ini begitu HP menjawab (biasanya < 30 detik).');
    }
    case '/bunyi': {
      const idsB = Object.keys(db.devices);
      if (!idsB.length) return send('Belum ada HP anak yang tertaut.');
      queueCommand('bunyi', null, idsB.length === 1 ? idsB[0] : '*'); db.bunyiOnAt = now(); saveDb();
      return send('\uD83D\uDD14 *BUNYIKAN HP dikirim* \u2014 HP anak berbunyi keras \u00b130 detik walau mode senyap. BUKA dari bot menghentikan bunyinya.');
    }
    case '/bunyimati': {
      const idsM = Object.keys(db.devices);
      db.bunyiOnAt = 0;
      if (idsM.length) queueCommand('stopbunyi', null, idsM.length === 1 ? idsM[0] : '*');
      saveDb();
      return sendRich(chatId, statusRichHtml(), 'Bunyi HP anak dimatikan.');
    }
    case '/tautgen': {
      const kode = newPairCode();
      return sendRich(chatId, tautRichHtml(), 'Kode sekali pakai baru: ' + kode + ' \u2014 ketik di aplikasi HP anak (berlaku 15 menit, sekali pakai).');
    }
    case '/matikan':
      // Urutan wajib dari user: SEBELUM MATI, video polisi tampil dulu (±20 detik), baru layar mati.
      db.policy.locked = true; db.policy.scareActive = true; queueCommand('matikan'); saveDb();
      return send('\u23FB *MATIKAN HP dikirim.* Urutannya: dalam \u00b110 detik *video polisi (paten) tampil dulu* di layar HP anak, setelah itu layarnya *mati & terkunci*. Saat layar dinyalakan lagi, video itu tetap tampil sampai kamu tekan BUKA.');
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
    case '/device':
      return sendRich(chatId, deviceRichHtml(), 'Menu DEVICE: + DEVICE, - DEVICE, LIST DEVICE.');
    case '/tambahdevice':
      return send('➕ *+ DEVICE — Tambah HP Anak*\nKode Pairing: `' + CHILD_CODE + '`\nAlamat Server: `163.52.135.130:2470`\nLangkah:\n1. Pasang aplikasi Parental Kids di HP anak\n2. Buka aplikasi, isi alamat server + kode pairing + nama HP\n3. Tekan Simpan + Hubungkan\n4. Aktifkan semua izin yang diminta\n5. Tekan Mulai Pemantauan\n\nSatu kode ini bisa dipakai di banyak HP anak sekaligus.');
    case '/listdevice':
      return sendRich(chatId, listDeviceRichHtml(), 'Daftar HP anak yang tertaut.');
    case '/pilihhapus':
      return sendRich(chatId, delDeviceRichHtml(), 'Pilih HP yang mau dihapus dari daftar.');
    case '/hapusdevice': {
      const hd = db.devices[arg];
      if (!hd) return send('HP tidak ditemukan di daftar.');
      delete db.devices[arg]; delete db.usage[arg]; saveDb();
      return send('🗑 *Device dihapus*\nNama: ' + hd.name + '\nStatus: Terlepas dari bot\nCatatan: bila aplikasi di HP itu masih terpasang dan aktif, HP bisa tertaut lagi. Hapus juga aplikasinya di HP anak untuk melepas total.');
    }
    case '/app': {
      if (!arg) return send('Aplikasi tidak ditemukan.');
      return sendRich(chatId, appRichHtml(arg), 'Pengaturan aplikasi ' + arg);
    }
    case '/appblok': {
      if (arg && !db.policy.blockedApps.includes(arg)) db.policy.blockedApps.push(arg);
      saveDb(); return sendRich(chatId, appRichHtml(arg), 'Aplikasi diblokir.');
    }
    case '/appunblk': {
      db.policy.blockedApps = db.policy.blockedApps.filter(x => x !== arg); saveDb();
      return sendRich(chatId, appRichHtml(arg), 'Blokir dibuka.');
    }
    case '/applimit': {
      const pkg = rest[0]; const n = parseInt(rest[1], 10);
      if (!pkg || isNaN(n)) return send('Format batas salah.');
      if (n <= 0) delete db.policy.perAppLimits[pkg]; else db.policy.perAppLimits[pkg] = n;
      saveDb(); return sendRich(chatId, appRichHtml(pkg), 'Batas aplikasi diatur.');
    }
    case '/fitur': {
      if (arg === 'polisi') return sendRich(chatId, polisiRichHtml(), 'Menu VIDEO POLISI.');
      if (FITUR_LABEL[arg]) return sendRich(chatId, fiturRichHtml(arg), 'Menu ' + FITUR_LABEL[arg] + '.');
      return send('Fitur tidak dikenal.');
    }
    case '/pset':
      return send('\uD83C\uDFAC *VIDEO POLISI SUDAH PATEN*\nVideo saat ini: ' + (db.scareVideo ? (db.scareVideo.fileName || 'video') : 'video bawaan aplikasi (kiriman kamu)') + '\nVideo ini tidak bisa diganti atau dihapus, sesuai perintahmu.');
    case '/phapus': {
      return send('\uD83C\uDFAC Video polisi sudah *PATEN* \u2014 tidak bisa dihapus, sesuai perintahmu.');


    }
    case '/ppilih':
      return sendRich(chatId, pickTargetRichHtml('polisi', 'ptarget'), 'Pilih device tujuan VIDEO POLISI.');
    case '/fpilih':
      if (!FITUR_LABEL[arg]) return send('Fitur tidak dikenal.');
      return sendRich(chatId, pickTargetRichHtml(arg, 'ftarget_' + arg), 'Pilih device tujuan ' + FITUR_LABEL[arg] + '.');
    case '/ptarget': {
      db.featureTargets = db.featureTargets || {}; db.featureTargets.polisi = arg === 'all' ? '*' : arg; saveDb();
      return sendRich(chatId, polisiRichHtml(), 'Device tujuan VIDEO POLISI diatur.');
    }
    case '/ftarget': {
      const f = rest[0]; const t = rest[1] || 'all';
      if (!FITUR_LABEL[f]) return send('Fitur tidak dikenal.');
      db.featureTargets = db.featureTargets || {}; db.featureTargets[f] = t === 'all' ? '*' : t; saveDb();
      return sendRich(chatId, fiturRichHtml(f), 'Device tujuan diatur.');
    }
    case '/pstart': {
      if (!Object.keys(db.devices).length) return send('Belum ada HP anak yang tertaut. Tambah dulu lewat tombol DEVICE.');
      if (Object.keys(db.devices).length === 1) { const fP = { chat: { id: chatId }, from: msg.from, text: '/pgo ' + Object.keys(db.devices)[0] }; return handleCommand(fP); }
      const html = '<p><b>START VIDEO \u2014 PILIH DEVICE</b></p>'
        + '<blockquote>Pilih HP yang layarnya mau ditampilkan video polisi.</blockquote>'
        + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
        + Object.keys(db.devices).map(id => '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="pgo_' + id + '">' + padLabel(esc(db.devices[id].name), 44) + '</tg-button></tg-button-row>').join('')
        + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="polisi">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
      return sendRich(chatId, html, 'Pilih device untuk START VIDEO.');
    }
    case '/pgo': {
      const t = arg === 'all' || !arg ? '*' : arg;
      const tname = t === '*' ? 'Semua HP' : ((db.devices[t] || {}).name || t);
      if (t !== '*' && !db.devices[t]) return send('HP tujuan tidak ditemukan.');
      polisiStart(t);
      const txt = '\🚨 VIDEO POLISI DITAMPILKAN. Dalam \u00b110 detik layar HP anak berubah jadi video itu dan terkunci di sana, Tekan button dibawah untuk buka';
      const html = '<p><b>VIDEO POLISI</b></p><blockquote>' + txt + '</blockquote>'
        + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr><tr><td>Target</td><td>' + esc(tname) + '</td></tr></table>'
        + '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="pbuka_' + (t === '*' ? 'all' : t) + '">' + padLabel('MATIKAN VIDEO', 44) + '</tg-button></tg-button-row>'
        + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="polisi">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
      return sendRich(chatId, html, txt);
    }
    case '/pmatikan': {
      if (!Object.keys(db.devices).length) return send('Belum ada HP anak yang tertaut.');
      if (Object.keys(db.devices).length === 1) { const fM = { chat: { id: chatId }, from: msg.from, text: '/pmgo ' + Object.keys(db.devices)[0] }; return handleCommand(fM); }
      const htmlM = '<p><b>MATIKAN VIDEO \u2014 PILIH DEVICE</b></p>'
        + '<blockquote>Pilih HP yang video polisinya mau dimatikan. Sesudah dimatikan, video hilang dari HP anak dan tidak muncul lagi; HP terbuka.</blockquote>'
        + '<table bordered striped><tr><th>PERANGKAT</th><th>KETERANGAN</th></tr>' + deviceRowsHtml() + '</table>'
        + Object.keys(db.devices).map(id => '<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="pmgo_' + id + '">' + padLabel(esc(db.devices[id].name), 44) + '</tg-button></tg-button-row>').join('')
        + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="polisi">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
      return sendRich(chatId, htmlM, 'Pilih device untuk MATIKAN VIDEO.');
    }
    case '/pmgo': {
      // MATIKAN VIDEO = lawan START VIDEO: video mati di HP anak, tidak muncul lagi, HP terbuka (BUKA TOTAL).
      clearAllLocks(); saveDb();
      const tname2 = arg && db.devices[arg] ? db.devices[arg].name : 'HP anak';
      const txt2 = '\u2705 VIDEO POLISI DIMATIKAN di ' + tname2 + '. Video hilang dari layar HP anak dan tidak akan muncul lagi. HP anak terbuka.';
      const html2 = '<p><b>MATIKAN VIDEO</b></p><blockquote>' + txt2 + '</blockquote>'
        + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="polisi">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
      return sendRich(chatId, html2, txt2);
    }
    case '/pbuka': {
      const t = arg === 'all' || !arg ? '*' : arg;
      const tname = t === '*' ? 'Semua HP' : ((db.devices[t] || {}).name || t);
      clearAllLocks(); saveDb();
      return send('\uD83D\uDD13 *DIBUKA TOTAL*\nTarget: ' + tname + '\nStatus: kunci, video polisi, jeda, dan timer \u2014 semuanya dimatikan');
    }
    case '/fstart': {
      const t = ftTarget(arg);
      const fake2 = { chat: { id: chatId }, from: msg.from, text: '/jalan ' + arg + ' ' + (t === '*' ? 'all' : t) };
      return handleCommand(fake2);
    }
    case '/aksi': {
      if (!FITUR_LABEL[arg]) return send('Fitur tidak dikenal.');
      if (!Object.keys(db.devices).length) return send('Belum ada HP anak yang tertaut. Tambah dulu lewat tombol + DEVICE.');
      if (Object.keys(db.devices).length === 1) { const fA = { chat: { id: chatId }, from: msg.from, text: '/jalan ' + arg + ' ' + Object.keys(db.devices)[0] }; return handleCommand(fA); }
      return sendRich(chatId, pickDeviceRichHtml(arg), 'Pilih HP tujuan perintah ' + (FITUR_LABEL[arg] || arg) + '.');
    }
    case '/jalan': {
      const fitur = rest[0]; let target = rest[1] || 'all';
      if (target === 'all' && Object.keys(db.devices).length === 1) target = Object.keys(db.devices)[0];
      const devId = target === 'all' ? '*' : target;
      const tname = target === 'all' ? 'Semua HP' : ((db.devices[target] || {}).name || target);
      if (target !== 'all' && !db.devices[target]) return send('HP tujuan tidak ditemukan.');
      if (fitur === 'polisi') {

        polisiStart(target);
        return send('🚨 *VIDEO POLISI dikirim*\nTarget: ' + tname + '\nStatus: Video tampil dalam ±10 detik, sesudah itu HP mati & terkunci sampai kamu tekan BUKA');
      }
      if (fitur === 'polisi_off') {
        if (target === 'all') db.policy.scareActive = false;
        else if (db.perDevice && db.perDevice[target]) delete db.perDevice[target].scareActive;
        queueCommand('unscare', null, devId); saveDb();
        return send('✅ *Video polisi dimatikan*\nTarget: ' + tname);
      }
      if (fitur === 'matikan') {
        setTargetLocked(target, true); if (target === 'all') db.policy.scareActive = true;
        queueCommand('matikan', null, devId); saveDb();
        return send('⏻ *MATIKAN HP dikirim*\nTarget: ' + tname + '\nUrutan: ' + (db.scareVideo ? 'video polisi tampil ±20 detik dulu, baru layar mati & terkunci' : 'layar langsung mati & terkunci (video polisi belum dipasang)'));
      }
      if (fitur === 'kunci') {
        setTargetLocked(target, true);
        queueCommand('lock', null, devId); saveDb();
        return send('🔒 *KUNCI dikirim*\nTarget: ' + tname);
      }
      if (fitur === 'buka') {
        clearAllLocks(); saveDb();
        return send('\uD83D\uDD13 *BUKA TOTAL dikirim*\nTarget: ' + tname + '\nStatus: kunci, video polisi, jeda, dan timer semuanya dimatikan');
      }
      return send('Fitur tidak dikenal.');
    }
    case '/tset': {
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 0) return send('Pilih menit dari tombol TIMER.');
      if (!Object.keys(db.devices).length) return send('Belum ada HP anak yang tertaut. Tambah dulu lewat tombol DEVICE.');
      if (Object.keys(db.devices).length === 1) { const fT = { chat: { id: chatId }, from: msg.from, text: '/tgo ' + n + ' ' + Object.keys(db.devices)[0] }; return handleCommand(fT); }
      return sendRich(chatId, pickAfterHtml('timer', n), 'Pilih device untuk timer.');
    }
    case '/tgo': {
      const n = parseInt(rest[0], 10); const target = rest[1] || 'all';
      if (isNaN(n)) return send('Format timer salah.');
      if (target !== 'all' && !db.devices[target]) return send('HP tujuan tidak ditemukan.');
      const until = n > 0 ? now() + n * 60000 : 0;
      if (target === 'all') db.policy.sessionUntil = until;
      else { db.perDevice = db.perDevice || {}; db.perDevice[target] = db.perDevice[target] || {}; db.perDevice[target].sessionUntil = until; }
      saveDb();
      return send('\u23f1 *SESI TIMER diatur*\nSesi: ' + (n === 0 ? 'Dimatikan' : n + ' menit (s/d ' + new Date(until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ')') + '\nTarget: ' + (target === 'all' ? 'Semua HP' : db.devices[target].name) + '\nStatus: Di HP anak muncul bubble hitung mundur; begitu habis HP mati & terkunci sampai kamu buka dari bot');
    }
    case '/jset': {
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 0) return send('Pilih menit dari tombol JEDA.');
      if (!Object.keys(db.devices).length) return send('Belum ada HP anak yang tertaut. Tambah dulu lewat tombol DEVICE.');
      if (Object.keys(db.devices).length === 1) { const fJ = { chat: { id: chatId }, from: msg.from, text: '/jgo ' + n + ' ' + Object.keys(db.devices)[0] }; return handleCommand(fJ); }
      return sendRich(chatId, pickAfterHtml('jeda', n), 'Pilih device untuk jeda.');
    }
    case '/jgo': {
      const n = parseInt(rest[0], 10); const target = rest[1] || 'all';
      if (isNaN(n)) return send('Format jeda salah.');
      if (target !== 'all' && !db.devices[target]) return send('HP tujuan tidak ditemukan.');
      db.perDevice = db.perDevice || {};
      if (n > 0) {
        const until = now() + n * 60000;
        if (target === 'all') { db.policy.pauseUntil = until; queueCommand('pause', null, '*'); }
        else { db.perDevice[target] = db.perDevice[target] || {}; db.perDevice[target].pauseUntil = until; queueCommand('pause', null, target); }
        saveDb();
        return send('\u23f8 *JEDA diatur*\nJeda: ' + n + ' menit (s/d ' + new Date(until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ')\nTarget: ' + (target === 'all' ? 'Semua HP' : db.devices[target].name));
      }
      if (target === 'all') { db.policy.pauseUntil = 0; for (const id of Object.keys(db.perDevice)) { if (db.perDevice[id]) delete db.perDevice[id].pauseUntil; } }
      else { db.perDevice[target] = db.perDevice[target] || {}; db.perDevice[target].pauseUntil = 0; }
      saveDb();
      return send('\u25b6 *Jeda diakhiri*\nTarget: ' + (target === 'all' ? 'Semua HP' : db.devices[target].name));
    }
    case '/laporan': return sendRich(chatId, laporanRichHtml(), laporanText());
    case '/status': return sendRich(chatId, statusRichHtml(), statusText());
    case '/kunci':
      db.policy.locked = true; queueCommand('lock'); saveDb();
      return send('🔒 Perintah *KUNCI* dikirim. HP anak akan terkunci dalam ±10 detik.');
    case '/buka':
      clearAllLocks(); saveDb();
      return send('\uD83D\uDD13 BUKA TOTAL: kunci, video polisi, jeda, dan timer semuanya dimatikan. HP anak bisa dipakai lagi.');
    case '/polisi': {

      polisiStart('*');
      return send('🚨 *VIDEO POLISI DITAMPILKAN.* Dalam ±10 detik layar HP anak berubah jadi video itu dan terkunci di sana, sampai kamu tekan tombol *Matikan Video Polisi* (atau /buka).');
    }
    case '/polisimati':
      clearAllLocks(); saveDb();
      return send('\u2705 Video polisi dimatikan. HP anak terbuka dan video tidak muncul lagi.');
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
      return sendRich(chatId, daftarBlokirRichHtml(), 'Daftar aplikasi yang diblokir.');
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
      if (!m) return sendRich(chatId, jadwalRichHtml(), jadwalText());
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
      return send('\uD83C\uDFAC Video polisi saat ini: *' + (db.scareVideo ? (db.scareVideo.fileName || 'video') : 'video bawaan aplikasi') + '* \u2014 PATEN, tidak bisa diganti atau dihapus.');


    case '/hapusvideo':
      return send('🎬 Video polisi sudah *PATEN* \u2014 tidak bisa dihapus/dimatikan, sesuai perintahmu.');
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
  const map = { menu: '/start', laporan: '/laporan', status: '/status', kunci: '/kunci', buka: '/buka', daftarblokir: '/daftarblokir', info_batas: '/batas', info_jadwal: '/jadwal', kode: '/kode', polisi: '/polisi', polisi_off: '/polisimati', taut: '/taut', tautgen: '/tautgen', lokasi: '/lokasi', bunyi: '/bunyi', bunyimati: '/bunyimati', matikan: '/matikan', timer: '/timer', jeda: '/jeda', timer_30: '/timer30', timer_60: '/timer60', timer_90: '/timer90', timer_120: '/timer120', timer_0: '/timer0', jeda_15: '/jeda15', jeda_30: '/jeda30', jeda_60: '/jeda60', jeda_off: '/jedabatal' };
  if (cb.data === 'device') { fake.text = '/device'; return handleCommand(fake); }
  if (cb.data === 'dev_add') { fake.text = '/tambahdevice'; return handleCommand(fake); }
  if (cb.data === 'dev_del') { fake.text = '/pilihhapus'; return handleCommand(fake); }
  if (cb.data === 'dev_list') { fake.text = '/listdevice'; return handleCommand(fake); }
  if (cb.data === 'polisi') { fake.text = '/fitur polisi'; return handleCommand(fake); }
  if (cb.data && ['matikan', 'kunci', 'buka'].includes(cb.data)) { fake.text = '/fitur ' + cb.data; return handleCommand(fake); }
  if (cb.data === 'polisi_off') { fake.text = '/pbuka ' + (ftTarget('polisi') === '*' ? 'all' : ftTarget('polisi')); return handleCommand(fake); }
  if (cb.data === 'pset') { fake.text = '/pset'; return handleCommand(fake); }
  if (cb.data === 'phapus') { fake.text = '/phapus'; return handleCommand(fake); }
  if (cb.data === 'pstart') { fake.text = '/pstart'; return handleCommand(fake); }
  if (cb.data === 'ppilih') { fake.text = '/ppilih'; return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('ptarget_') === 0) { fake.text = '/ptarget ' + cb.data.slice(8); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('fpilih_') === 0) { fake.text = '/fpilih ' + cb.data.slice(7); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('ftarget_') === 0) { const r = cb.data.slice(8); const li = r.lastIndexOf('_'); fake.text = '/ftarget ' + r.slice(0, li) + ' ' + r.slice(li + 1); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('fstart_') === 0) { fake.text = '/fstart ' + cb.data.slice(7); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('pbuka_') === 0) { fake.text = '/pbuka ' + cb.data.slice(6); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('pgo_') === 0) { fake.text = '/pgo ' + cb.data.slice(4); return handleCommand(fake); }
  if (cb.data === 'pmatikan') { fake.text = '/pmatikan'; return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('pmgo_') === 0) { fake.text = '/pmgo ' + cb.data.slice(5); return handleCommand(fake); }
  if (cb.data === 'presetkecil') { fake.text = '/presetanakkecil'; return handleCommand(fake); }
  if (cb.data === 'sch_belajar') { fake.text = '/jadwal 19:00-21:00 belajar'; return handleCommand(fake); }
  if (cb.data === 'sch_tidur') { fake.text = '/jadwal 20:00-05:30 tidur malam'; return handleCommand(fake); }
  if (cb.data === 'sch_sekolah') { fake.text = '/jadwal 07:00-13:00 sekolah'; return handleCommand(fake); }
  if (cb.data === 'schdel') { fake.text = '/hapusjadwal'; return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('appblok_') === 0) { fake.text = '/appblok ' + cb.data.slice(8); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('appunblk_') === 0) { fake.text = '/appunblk ' + cb.data.slice(9); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('applimit_') === 0) { const r = cb.data.slice(9); const li = r.lastIndexOf('_'); fake.text = '/applimit ' + r.slice(0, li) + ' ' + r.slice(li + 1); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('unblk_') === 0) { fake.text = '/appunblk ' + cb.data.slice(6); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('app_') === 0) { fake.text = '/app ' + cb.data.slice(4); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('tset_') === 0) { fake.text = '/tset ' + cb.data.slice(5); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('jset_') === 0) { fake.text = '/jset ' + cb.data.slice(5); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('tgo_') === 0) { const r = cb.data.slice(4); const li = r.lastIndexOf('_'); fake.text = '/tgo ' + r.slice(0, li) + ' ' + r.slice(li + 1); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('jgo_') === 0) { const r = cb.data.slice(4); const li = r.lastIndexOf('_'); fake.text = '/jgo ' + r.slice(0, li) + ' ' + r.slice(li + 1); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('act_') === 0) { const li = cb.data.lastIndexOf('_'); fake.text = '/jalan ' + cb.data.slice(4, li) + ' ' + cb.data.slice(li + 1); return handleCommand(fake); }
  if (cb.data && cb.data.indexOf('del_') === 0) { fake.text = '/hapusdevice ' + cb.data.slice(4); return handleCommand(fake); }
  if (map[cb.data]) { fake.text = map[cb.data]; return handleCommand(fake); }
}

let offset = 0;
async function poll() {
  if (!BOT_TOKEN || BOT_TOKEN.includes('isi_token')) { console.log('[bot] BOT_TOKEN belum diisi, polling Telegram dilewati. API HP anak tetap jalan.'); return; }
  // Bersihkan layar bot sisa jalan sebelumnya agar chat mulai bersih
  if (db.lastBotMsg) {
    for (const cid of Object.keys(db.lastBotMsg)) {
      if (db.lastBotMsg[cid]) tg('deleteMessage', { chat_id: cid, message_id: db.lastBotMsg[cid] }).catch(() => {});
    }
    db.lastBotMsg = {}; saveDb();
  }
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
function authed(req) {
  if ((req.headers['x-child-code'] || '') === CHILD_CODE) return true;
  const tok = req.headers['x-device-token'] || '';
  return !!(tok && (db.deviceTokens || {})[tok]);
}
function newPairCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  db.pairCodes = {};
  let code = '';
  for (let i = 0; i < 6; i++) code += abc[Math.floor(Math.random() * abc.length)];
  db.pairCodes[code] = { createdAt: now(), usedBy: null };
  saveDb();
  return code;
}
function activePairCode() {
  const pcs = db.pairCodes || {};
  for (const c of Object.keys(pcs)) if (!pcs[c].usedBy && now() - pcs[c].createdAt < 15 * 60000) return c;
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return json(res, 200, { ok: true, devices: Object.keys(db.devices).length });
  if (p.startsWith('/api/') && p !== '/api/register' && !authed(req)) return json(res, 401, { ok: false, error: 'kode pairing salah' });

  if (p === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const id = b.deviceId || crypto.createHash('sha1').update((b.model || '') + (b.deviceName || '') + CHILD_CODE).digest('hex').slice(0, 12);
    const code = req.headers['x-child-code'] || '';
    if (code !== CHILD_CODE) {
      const pc = (db.pairCodes || {})[code];
      if (!pc || pc.usedBy || now() - pc.createdAt > 15 * 60000) return json(res, 401, { ok: false, error: 'kode sekali pakai tidak berlaku (sudah dipakai / kedaluwarsa) \u2014 generate kode baru di menu TAUT HP bot' });
      pc.usedBy = id; pc.usedAt = now();
    }
    db.devices[id] = Object.assign({}, db.devices[id], { name: b.deviceName || 'HP Anak', model: b.model || '', android: b.androidVersion || '', lastSeen: now() });
    if (db.perDevice) delete db.perDevice[id]; // penautan baru = mulai bersih (hapus kunci khusus HP ini)
    if (db.commands) delete db.commands[id];
    db.deviceTokens = db.deviceTokens || {};
    for (const t of Object.keys(db.deviceTokens)) if (db.deviceTokens[t] === id) delete db.deviceTokens[t];
    const deviceToken = crypto.randomBytes(18).toString('hex');
    db.deviceTokens[deviceToken] = id;
    saveDb(); return json(res, 200, { ok: true, deviceId: id, deviceToken });
  }
  if (p === '/api/heartbeat' && req.method === 'POST') {
    const b = await readBody(req); let d = db.devices[b.deviceId];
    if (!d) { d = db.devices[b.deviceId] = { name: b.deviceName || 'HP Anak', model: b.model || '', android: b.androidVersion || '', lastSeen: now() }; }
    d.lastSeen = now(); if (b.battery != null) d.battery = b.battery; if (b.foregroundApp) d.foregroundApp = b.foregroundApp;
    saveDb(); return json(res, 200, { ok: true });
  }
  if (p === '/api/usage' && req.method === 'POST') {
    const b = await readBody(req); if (!db.devices[b.deviceId]) db.devices[b.deviceId] = { name: b.deviceName || 'HP Anak', model: b.model || '', android: b.androidVersion || '', lastSeen: now() };
    db.usage[b.deviceId] = { date: b.date, totalMinutes: b.totalMinutes || 0, apps: b.apps || [], receivedAt: now() };
    saveDb(); return json(res, 200, { ok: true });
  }
  if (p === '/api/location' && req.method === 'POST') {
    const b = await readBody(req); const d = db.devices[b.deviceId];
    if (d && b.lat != null && b.lng != null) {
      const lat = Number(b.lat).toFixed(6), lng = Number(b.lng).toFixed(6);
      const html = '<p><b>LOKASI HP ANAK</b></p>'
        + '<table bordered striped><tr><th>INFO</th><th>KETERANGAN</th></tr>'
        + '<tr><td>Perangkat</td><td>' + esc(d.name) + '</td></tr>'
        + '<tr><td>Waktu</td><td>' + new Date(now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + '</td></tr>'
        + '<tr><td>Akurasi</td><td>' + (b.accuracy ? '\u00b1' + Math.round(b.accuracy) + ' m' : '-') + '</td></tr>'
        + '<tr><td>Koordinat</td><td>' + lat + ', ' + lng + '</td></tr></table>'
        + '<blockquote><a href="https://maps.google.com/?q=' + lat + ',' + lng + '">Buka di Google Maps</a></blockquote>'
        + '<tg-button-row align="center"><tg-button type="callback_data" style="link" data="status">' + padLabel('Kembali', 44) + '</tg-button></tg-button-row>';
      for (const pid of PARENT_IDS) sendRich(pid, html, 'Lokasi ' + d.name + ': ' + lat + ', ' + lng, false).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/alert' && req.method === 'POST') {
    const b = await readBody(req);
    const d = db.devices[b.deviceId];
    const text = '⚠ *ALERT dari HP anak' + (d ? ' (' + d.name + ')' : '') + '*\n' + (b.message || b.type || 'alert');
    for (const pid of PARENT_IDS) {
      sendRich(pid, toRichHtml(text), text, false).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/policy' && req.method === 'GET') {
    const pol = Object.assign({}, db.policy, { hasScareVideo: !!db.scareVideo, scareVideoSetAt: db.scareVideo ? db.scareVideo.setAt : 0 });
    const didQ = url.searchParams.get('deviceId');
    const pd = didQ && db.perDevice ? db.perDevice[didQ] : null;
    if (pd) {
      if (Object.prototype.hasOwnProperty.call(pd, 'dailyLimitMinutes')) pol.dailyLimitMinutes = pd.dailyLimitMinutes;
      if (Object.prototype.hasOwnProperty.call(pd, 'pauseUntil')) pol.pauseUntil = pd.pauseUntil;
      if (Object.prototype.hasOwnProperty.call(pd, 'sessionUntil')) pol.sessionUntil = pd.sessionUntil;
      if (Object.prototype.hasOwnProperty.call(pd, 'locked')) pol.locked = pd.locked;
      if (Object.prototype.hasOwnProperty.call(pd, 'scareActive')) pol.scareActive = pd.scareActive;
    }
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
