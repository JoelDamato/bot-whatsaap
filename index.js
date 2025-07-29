// index.js (Versión con más logs para depuración)
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path =require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// --- Lógica para la ruta de la sesión ---
const RENDER_SESSION_DIR = '/data/session';
const LOCAL_SESSION_DIR = path.join(__dirname, 'session');
const authFolderPath = fs.existsSync(RENDER_SESSION_DIR) ? RENDER_SESSION_DIR : LOCAL_SESSION_DIR;
console.log(`[INFO] Usando la carpeta de sesión: ${authFolderPath}`);
if (!fs.existsSync(authFolderPath)) {
    fs.mkdirSync(authFolderPath, { recursive: true });
}

let lastQR = '';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
    });

    // --- Endpoint para enviar mensajes con MÁS LOGS ---
    app.post('/enviar-mensaje', async (req, res) => {
        console.log('[DEBUG] Se recibió una solicitud en /enviar-mensaje');
        const { numero, texto } = req.body;

        if (!numero || !texto) {
            console.log('[DEBUG] Faltan número o texto.');
            return res.status(400).json({ error: 'El número y el texto son obligatorios' });
        }

        try {
            const jid = `${numero}@s.whatsapp.net`;
            console.log(`[DEBUG] Verificando número: ${jid}`);
            
            const [result] = await sock.onWhatsApp(jid);
            console.log(`[DEBUG] Resultado de onWhatsApp:`, result);

            if (result?.exists) {
                console.log(`[DEBUG] El número existe. Enviando mensaje...`);
                await sock.sendMessage(jid, { text: texto });
                console.log(`[DEBUG] Mensaje enviado con éxito.`);
                res.json({ success: true, message: `Mensaje enviado a ${numero}` });
            } else {
                console.log(`[DEBUG] El número no existe.`);
                res.status(404).json({ error: 'El número no existe en WhatsApp' });
            }
        } catch (error) {
            console.error('[ERROR] Falló el bloque try/catch de /enviar-mensaje:', error);
            res.status(500).json({ error: 'Hubo un error al enviar el mensaje' });
        }
    });

    app.get('/qr', async (req, res) => {
        // ... (código del qr sin cambios)
    });

    sock.ev.on('connection.update', (update) => {
        // ... (código de conexión sin cambios)
    });

    startBot();
}

app.listen(port, () => {
    console.log(`🚀 Servidor iniciado en el puerto ${port}. El bot de WhatsApp se está conectando...`);
    startBot();
});