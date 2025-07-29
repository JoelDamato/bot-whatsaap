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

// --- Lógica de sesión corregida ---
const RENDER_DATA_DIR = '/data';
const LOCAL_SESSION_DIR = path.join(__dirname, 'session');

// Usamos la carpeta /data si existe (en Render), si no, la local
const sessionDir = fs.existsSync(RENDER_DATA_DIR) ? path.join(RENDER_DATA_DIR, 'session') : LOCAL_SESSION_DIR;
console.log(`[INFO] Directorio de sesión a usar: ${sessionDir}`);

// Asegurarse de que la carpeta de sesión exista
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}
// --- Fin de la lógica ---

let sock; // Definimos sock aquí para que sea accesible globalmente
let lastQR = '';

async function startBot() {
    console.log('[INFO] Iniciando el bot de WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[INFO] Se recibió un nuevo QR. Accede a /qr para escanear.');
            lastQR = qr;
        }

        if (connection === 'close') {
            lastQR = '';
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔌 Conexión cerrada. Reiniciando bot...');
                startBot();
            } else {
                console.log('❌ Conexión cerrada permanentemente.');
            }
        } else if (connection === 'open') {
            lastQR = '';
            console.log('✅ ¡Conectado a WhatsApp!');
        }
    });

    // ... aquí irían otros listeners como 'messages.upsert' si los necesitas ...
}

// --- Endpoints del servidor ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, texto } = req.body;
    if (!numero || !texto) return res.status(400).json({ error: 'Faltan número o texto' });

    if (!sock || sock.ws.readyState !== sock.ws.OPEN) {
        return res.status(503).json({ error: 'El bot no está conectado a WhatsApp. Espera un momento.' });
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
        console.error('[ERROR] /enviar-mensaje:', error);
        res.status(500).json({ error: 'Error interno al enviar el mensaje' });
    }
});

app.get('/qr', async (req, res) => {
    if (lastQR) {
        try {
            const qrImage = await QRCode.toDataURL(lastQR);
            res.send(`<img src="${qrImage}" alt="Escanea este QR" />`);
        } catch (err) {
            res.status(500).send('Error al generar la imagen del QR');
        }
    } else {
        res.send('<h1>No hay un código QR disponible.</h1>');
    }
});

// --- Iniciar todo ---
app.listen(port, () => {
    console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
    startBot();
});