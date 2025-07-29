// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs'); // Importamos fs para verificar si existe la carpeta
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// --- Lógica para la ruta de la sesión ---
const RENDER_SESSION_DIR = '/data/session';
const LOCAL_SESSION_DIR = path.join(__dirname, 'session');

// Usamos la carpeta de Render si existe, si no, la local
const authFolderPath = fs.existsSync(RENDER_SESSION_DIR) ? RENDER_SESSION_DIR : LOCAL_SESSION_DIR;
console.log(`[INFO] Usando la carpeta de sesión: ${authFolderPath}`);

// Asegurarse de que la carpeta de sesión exista
if (!fs.existsSync(authFolderPath)) {
    fs.mkdirSync(authFolderPath, { recursive: true });
}
// --- Fin de la lógica de sesión ---

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
    });

    app.post('/enviar-mensaje', async (req, res) => {
        const { numero, texto } = req.body;
        if (!numero || !texto) return res.status(400).json({ error: 'El número y el texto son obligatorios' });
        try {
            const jid = `${numero}@s.whatsapp.net`;
            const [result] = await sock.onWhatsApp(jid);
            if (result?.exists) {
                await sock.sendMessage(jid, { text: texto });
                res.json({ success: true, message: `Mensaje enviado a ${numero}` });
            } else {
                res.status(404).json({ error: 'El número no existe en WhatsApp' });
            }
        } catch (error) {
            console.error('[ERROR] /enviar-mensaje:', error);
            res.status(500).json({ error: 'Hubo un error al enviar el mensaje' });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('--- ¡NUEVO QR! Escanéalo rápido ---');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔌 Conexión cerrada. Reiniciando...');
                startBot();
            } else {
                console.log('❌ Conexión cerrada permanentemente. No se reconectará.');
            }
        } else if (connection === 'open') {
            console.log('✅ ¡Conectado a WhatsApp!');
            app.listen(port, () => {
                console.log(`🚀 Servidor escuchando en el puerto ${port}`);
            });
        }
    });
}

startBot();