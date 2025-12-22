const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const sharp = require('sharp');

const sessionsDir = path.join(process.cwd(), 'sessions');

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Estructura por sesión:
// {
//   sock,
//   status: 'waiting_for_scan' | 'connected' | 'disconnected' | 'error',
//   lastQR,
//   phone,
//   lastSync,
//   messagesSent,
//   sessionDir,
//   stats
// }
const clients = new Map();

function getSessionDir(sessionId) {
  return path.join(sessionsDir, sessionId);
}

function log(sessionId, message) {
  const dir = getSessionDir(sessionId);
  const logFile = path.join(dir, 'logs.txt');
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFile(logFile, line, () => {});
}

async function startClient(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const clientInfo = {
    status: 'initializing',
    lastQR: '',
    phone: null,
    lastSync: null,
    messagesSent: 0,
    sessionDir,
    stats: { planLimit: 1000 },
  };

  const sock = makeWASocket({
    version,
    auth: state,
    logger: undefined,
    printQRInTerminal: false,
    browser: ['Lovable', 'Chrome', '1.0'],
  });

  clientInfo.sock = sock;
  clients.set(sessionId, clientInfo);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      clientInfo.lastQR = qr;
      clientInfo.status = 'waiting_for_scan';
      log(sessionId, '[QR] Nuevo QR generado');
    }

    if (connection === 'open') {
      clientInfo.status = 'connected';
      clientInfo.lastQR = '';
      clientInfo.phone = sock.user?.id || null;
      clientInfo.lastSync = new Date().toISOString();
      log(sessionId, `[CONNECTION] Conectado como ${clientInfo.phone}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      clientInfo.status = 'disconnected';
      log(sessionId, `[CONNECTION] Desconectado código=${code} reconnect=${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => startClient(sessionId).catch(() => {}), 5000);
      } else {
        clients.delete(sessionId);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.key?.fromMe && msg?.message) {
      log(sessionId, `[MSG IN] de ${msg.key.remoteJid}`);
    }
  });

  return clientInfo;
}

async function getClient(sessionId) {
  if (!clients.has(sessionId)) {
    await startClient(sessionId);
  }
  return clients.get(sessionId);
}

async function getQR(sessionId) {
  const info = await getClient(sessionId);

  if (info.status === 'connected') {
    return { qr: null, status: 'connected', phone: info.phone };
  }

  if (!info.lastQR) {
    return { qr: null, status: info.status || 'pending' };
  }

  const qrImage = await QRCode.toDataURL(info.lastQR);
  return { qr: qrImage, status: 'waiting_for_scan' };
}

async function getStatus(sessionId) {
  const info = await getClient(sessionId);
  return {
    status: info.status,
    phone: info.phone,
    lastSync: info.lastSync,
  };
}

function formatJid(to) {
  const clean = String(to).replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

async function ensureWhatsAppExists(sock, jid) {
  const res = await sock.onWhatsApp(jid);
  const check = Array.isArray(res) ? res[0] : res;
  if (!check?.exists) {
    const err = new Error(`El número ${jid} no existe en WhatsApp`);
    err.status = 400;
    throw err;
  }
}

async function sendMessage(sessionId, to, message) {
  const info = await getClient(sessionId);
  const { sock } = info;

  if (!sock?.user) {
    const err = new Error('Sesión desconectada o no autenticada');
    err.status = 503;
    throw err;
  }

  const jid = formatJid(to);
  await ensureWhatsAppExists(sock, jid);

  await sock.sendMessage(jid, { text: message });
  info.messagesSent += 1;

  log(sessionId, `[MSG OUT] a ${jid} :: ${message.substring(0, 60)}`);

  return { status: 'sent' };
}

async function getStats(sessionId) {
  const info = await getClient(sessionId);
  const planLimit = info.stats?.planLimit || 1000;
  const messagesSent = info.messagesSent || 0;
  return {
    messagesSent,
    planLimit,
    remaining: Math.max(planLimit - messagesSent, 0),
  };
}

async function setGroupPhotoFromUrl(sessionId, groupJid, imageUrl) {
  const info = await getClient(sessionId);
  const { sock } = info;
  const response = await fetch(imageUrl);
  const buf = Buffer.from(await response.arrayBuffer());

  const processed = await sharp(buf)
    .resize(640, 640, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer();

  await sock.updateProfilePicture(groupJid, processed);
}

module.exports = {
  getClient,
  getQR,
  getStatus,
  sendMessage,
  getStats,
  setGroupPhotoFromUrl,
};


