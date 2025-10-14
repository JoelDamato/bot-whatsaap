// Versión simplificada del bot para probar conexión
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// Directorio de sesión
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

let sock;
let lastQR = '';

async function startBot() {
    console.log('[INFO] Iniciando conexión con WhatsApp...');
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        sock = makeWASocket({
            logger: pino({ level: 'silent' }), 
            auth: state,
            printQRInTerminal: true,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('[INFO] QR generado - escanea con WhatsApp');
                lastQR = qr;
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const reason = DisconnectReason[statusCode] || 'desconocida';
                console.log(`🔌 Conexión cerrada: ${reason}`);
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada - elimina la carpeta session para reconectar');
                } else {
                    console.log('🔄 Reconectando en 5 segundos...');
                    setTimeout(() => startBot(), 5000);
                }
            } else if (connection === 'open') {
                lastQR = '';
                console.log('✅ ¡Bot conectado a WhatsApp!');
            }
        });

    } catch (error) {
        console.error('[ERROR] Error al iniciar bot:', error);
        setTimeout(() => startBot(), 10000);
    }
}

// Endpoints básicos
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, texto } = req.body;
    if (!numero || !texto) {
        return res.status(400).json({ error: 'El número y el texto son obligatorios' });
    }

    if (!sock || sock.ws.readyState !== sock.ws.OPEN) {
        return res.status(503).json({ error: 'Bot no conectado' });
    }

    try {
        const jid = `${numero}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: texto });
        res.json({ success: true, message: `Mensaje enviado a ${numero}` });
    } catch (error) {
        console.error('[ERROR] Error al enviar mensaje:', error);
        res.status(500).json({ error: 'Error al enviar el mensaje' });
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
        res.send('<h1>No hay un código QR disponible.</h1><p>Esperando conexión...</p>');
    }
});

app.get('/estado', (req, res) => {
    res.json({
        conectado: sock && sock.ws.readyState === sock.ws.OPEN,
        qrDisponible: !!lastQR
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
    startBot();
});
