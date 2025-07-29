// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode'); // Usaremos la librería qrcode completa

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// Lógica para la ruta de la sesión
const RENDER_SESSION_DIR = '/data/session';
const LOCAL_SESSION_DIR = path.join(__dirname, 'session');
const authFolderPath = fs.existsSync(RENDER_SESSION_DIR) ? RENDER_SESSION_DIR : LOCAL_SESSION_DIR;
console.log(`[INFO] Usando la carpeta de sesión: ${authFolderPath}`);

if (!fs.existsSync(authFolderPath)) {
    fs.mkdirSync(authFolderPath, { recursive: true });
}

// Variable para guardar el string del QR
let lastQR = '';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), 
        auth: state,
    });

    // --- Endpoints del servidor ---
    app.post('/enviar-mensaje', async (req, res) => {
        // ... (código para enviar mensaje, no se necesita cambiar)
    });

    // Nuevo endpoint para mostrar el QR como imagen
    app.get('/qr', async (req, res) => {
        if (lastQR) {
            try {
                const qrImage = await QRCode.toDataURL(lastQR);
                res.send(`<img src="${qrImage}" alt="Escanea este QR" />`);
            } catch (err) {
                res.status(500).send('Error al generar la imagen del QR');
            }
        } else {
            res.send('<h1>No hay un código QR disponible.</h1><p>Asegúrate de que el bot se esté iniciando o reinicia el servicio.</p>');
        }
    });
    // --- Fin de Endpoints ---

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[INFO] Se recibió un nuevo QR. Accede a la URL de tu servicio seguida de /qr para escanearlo.');
            lastQR = qr; // Guardamos el QR
        }

        if (connection === 'close') {
            lastQR = ''; // Limpiamos el QR cuando la conexión se cierra
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                startBot();
            } else {
                console.log('❌ Conexión cerrada permanentemente.');
            }
        } else if (connection === 'open') {
            lastQR = ''; // Limpiamos el QR una vez conectado
            console.log('✅ ¡Conectado a WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (messages) => { /* ... */ });
}

// Iniciar el servidor Express inmediatamente para que el endpoint /qr siempre esté disponible
app.listen(port, () => {
    console.log(`🚀 Servidor iniciado en el puerto ${port}. El bot de WhatsApp se está conectando...`);
    startBot();
});