// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// --- Lógica de sesión definitiva ---
const IS_RENDER = process.env.RENDER === 'true';
const sessionDir = IS_RENDER ? '/data/session' : path.join(__dirname, 'session');

console.log(`[INFO] Entorno de Render detectado: ${IS_RENDER}`);
console.log(`[INFO] Usando directorio de sesión: ${sessionDir}`);

if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    console.log(`[INFO] Directorio de sesión creado: ${sessionDir}`);
}

let sock;
let lastQR = '';
let hasEverConnected = false;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// --- Sistema de Cola de Mensajes ---
class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.pendingResponses = new Map();
    }

    async addMessage(numero, texto, res) {
        const messageData = {
            numero,
            texto,
            res,
            attempts: 0,
            maxAttempts: 3,
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString()
        };
        
        this.queue.push(messageData);
        this.pendingResponses.set(messageData.id, res);
        console.log(`[COLA] Mensaje agregado a la cola. Total en cola: ${this.queue.length}`);
        
        if (!this.processing) {
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        console.log(`[COLA] Procesando cola. Pendientes: ${this.queue.length}`);

        while (this.queue.length > 0) {
            const messageData = this.queue.shift();
            await this.processMessage(messageData);

            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        this.processing = false;
        console.log('[COLA] Cola procesada completamente');
    }

    async processMessage(messageData) {
        const { numero, texto, attempts, maxAttempts, id } = messageData;

        console.log(`[COLA] Procesando mensaje ${id} (intento ${attempts + 1}/${maxAttempts})`);

        try {
            if (!sock || !sock.user) throw new Error('Bot no conectado a WhatsApp');

            const cleanNumber = numero.replace(/\D/g, '');
            const jid = `${cleanNumber}@s.whatsapp.net`;

            const [result] = await sock.onWhatsApp(jid);
            if (!result?.exists) throw new Error(`El número ${cleanNumber} no existe en WhatsApp`);

            await sock.sendMessage(jid, { text: texto });

            console.log(`[COLA] ✅ Mensaje enviado a ${cleanNumber}`);

            if (this.pendingResponses.has(id)) {
                const response = this.pendingResponses.get(id);
                response.json({ success: true, message: `Mensaje enviado a ${cleanNumber}`, queueId: id });
                this.pendingResponses.delete(id);
            }

        } catch (error) {
            console.error(`[COLA] ❌ Error mensaje ${id}:`, error.message);

            const newAttempts = attempts + 1;

            if (newAttempts < maxAttempts) {
                setTimeout(() => {
                    this.queue.push({ ...messageData, attempts: newAttempts });
                    if (!this.processing) this.processQueue();
                }, 5000);
            } else {
                if (this.pendingResponses.has(id)) {
                    const response = this.pendingResponses.get(id);
                    response.status(500).json({ success: false, error: error.message, queueId: id });
                    this.pendingResponses.delete(id);
                }
            }
        }
    }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            pendingResponses: this.pendingResponses.size
        };
    }
}

const messageQueue = new MessageQueue();

async function startBot() {
    if (isConnecting) return;

    isConnecting = true;
    console.log('[INFO] Iniciando conexión con WhatsApp…');

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                lastQR = qr;
                console.log('[QR] Nuevo QR generado');
            }

            if (connection === 'open') {
                isConnecting = false;
                lastQR = '';
                hasEverConnected = true;
                reconnectAttempts = 0;
                console.log('✅ Bot conectado a WhatsApp');
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada, limpiando…');

                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    fs.mkdirSync(sessionDir, { recursive: true });

                    setTimeout(startBot, 2000);
                } else {
                    console.log('🔄 Reintentando conexión en 5s…');
                    setTimeout(startBot, 5000);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                console.log(`[MSG] Mensaje recibido de ${msg.key.remoteJid}`);
            }
        });

    } catch (error) {
        isConnecting = false;
        console.error('[ERROR] Al iniciar bot:', error);
        setTimeout(startBot, 5000);
    }
}

// --- ENDPOINTS ---
app.post('/enviar-mensaje', (req, res) => {
    const { numero, texto } = req.body;

    if (!numero || !texto)
        return res.status(400).json({ success: false, error: 'Número y texto obligatorios' });

    if (!sock || !sock.user)
        return res.status(503).json({ success: false, error: 'Bot desconectado. Escaneá el QR.' });

    messageQueue.addMessage(numero, texto, res);
});

app.post('/limpiar-sesion', async (req, res) => {
    try {
        if (sock) await sock.logout();

        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        lastQR = '';
        hasEverConnected = false;

        setTimeout(startBot, 2000);

        res.json({ success: true, message: 'Sesión limpiada. Se generará un nuevo QR.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/estado-cola', (req, res) => {
    const status = messageQueue.getQueueStatus();
    const botConectado = sock && sock.user;

    res.json({
        success: true,
        cola: status,
        botConectado,
        qrDisponible: !!lastQR,
        estado: botConectado ? 'conectado' : (lastQR ? 'esperando_qr' : 'desconectado')
    });
});

app.get('/qr', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');

    const botConectado = sock && sock.user;

    if (botConectado) {
        return res.send(`<h1>Bot conectado ✔️</h1><p>${sock.user.id}</p>`);
    }

    if (lastQR) {
        const qrImage = await QRCode.toDataURL(lastQR);
        return res.send(`<img src="${qrImage}" width="300"/>`);
    }

    res.send(`<h1>Generando QR…</h1>`);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: !!sock?.user });
});

app.get('/', (req, res) => res.redirect('/qr'));

// --- Iniciar servidor y bot ---
app.listen(port, () => {
    console.log(`🚀 Servidor Express en puerto ${port}`);
    startBot();
});
