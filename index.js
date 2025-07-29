// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
}
// --- Fin de la lógica ---

let sock;
let lastQR = '';

async function startBot() {
    console.log('[INFO] Iniciando conexión con WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[INFO] Se recibió un nuevo QR.');
            lastQR = qr;
        }

        if (connection === 'close') {
            lastQR = '';
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            console.log(`🔌 Conexión cerrada, razón: ${DisconnectReason[statusCode] || 'desconocida'}`);
            
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Intentando reconectar...');
                startBot();
            } else {
                console.log('❌ Conexión cerrada permanentemente por logout.');
            }
        } else if (connection === 'open') {
            lastQR = '';
            console.log('✅ ¡Bot conectado a WhatsApp!');
        }
    });
}

// --- Endpoints del Servidor ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, texto } = req.body;
    if (!numero || !texto) {
        return res.status(400).json({ error: 'El número y el texto son obligatorios' });
    }

    if (!sock || sock.ws.readyState !== sock.ws.OPEN) {
        return res.status(503).json({ error: 'El bot no está conectado a WhatsApp en este momento.' });
    }

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
        console.error('[ERROR] en /enviar-mensaje:', error);
        res.status(500).json({ error: 'Error interno al enviar el mensaje' });
    }
});

app.get('/qr', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (lastQR) {
        try {
            const qrImage = await QRCode.toDataURL(lastQR);
            res.send(`<img src="${qrImage}" alt="Escanea este código QR" style="width:300px;height:300px;"/>`);
        } catch (err) {
            res.status(500).send('Error al generar la imagen del QR');
        }
    } else {
        res.send('<h1>No hay un código QR disponible.</h1><p>Si el bot está conectado, no se mostrará ningún QR.</p>');
    }
});

// --- Iniciar Servidor y Bot ---
app.listen(port, () => {
    console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
    startBot();
});