// Bot WhatsApp con configuración de red optimizada
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// --- Sistema de Cola de Mensajes ---
class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    async addMessage(numero, texto, res) {
        const messageData = {
            numero,
            texto,
            res,
            attempts: 0,
            maxAttempts: 4,
            id: Date.now() + Math.random()
        };
        
        this.queue.push(messageData);
        console.log(`[COLA] Mensaje agregado a la cola. Total en cola: ${this.queue.length}`);
        
        if (!this.processing) {
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        console.log(`[COLA] Procesando cola. Mensajes pendientes: ${this.queue.length}`);

        while (this.queue.length > 0) {
            const messageData = this.queue.shift();
            await this.processMessage(messageData);
        }

        this.processing = false;
        console.log('[COLA] Cola procesada completamente');
    }

    async processMessage(messageData) {
        const { numero, texto, res, attempts, maxAttempts, id } = messageData;
        
        console.log(`[COLA] Procesando mensaje ${id} (intento ${attempts + 1}/${maxAttempts})`);

        try {
            if (!sock || sock.ws.readyState !== sock.ws.OPEN) {
                throw new Error('Bot no conectado a WhatsApp');
            }

            const jid = `${numero}@s.whatsapp.net`;
            const [result] = await sock.onWhatsApp(jid);
            
            if (!result?.exists) {
                throw new Error('El número no existe en WhatsApp');
            }

            await sock.sendMessage(jid, { text: texto });
            
            console.log(`[COLA] Mensaje ${id} enviado exitosamente a ${numero}`);
            res.json({ 
                success: true, 
                message: `Mensaje enviado a ${numero}`,
                queueId: id,
                attempts: attempts + 1
            });

        } catch (error) {
            console.error(`[COLA] Error en mensaje ${id} (intento ${attempts + 1}):`, error.message);
            
            const newAttempts = attempts + 1;
            
            if (newAttempts < maxAttempts) {
                console.log(`[COLA] Reintentando mensaje ${id} en 10 segundos...`);
                
                setTimeout(() => {
                    this.queue.unshift({
                        ...messageData,
                        attempts: newAttempts
                    });
                    this.processQueue();
                }, 10000);
                
            } else {
                console.error(`[COLA] Mensaje ${id} falló después de ${maxAttempts} intentos`);
                res.status(500).json({ 
                    error: 'Error al enviar el mensaje después de múltiples intentos',
                    details: error.message,
                    queueId: id,
                    attempts: newAttempts
                });
            }
        }
    }

    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
}

const messageQueue = new MessageQueue();

// --- Configuración de sesión ---
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
            browser: ['Bot WhatsApp', 'Chrome', '1.0.0'],
            connectTimeoutMs: 120000, // 2 minutos
            keepAliveIntervalMs: 60000, // 1 minuto
            retryRequestDelayMs: 2000, // 2 segundos
            maxMsgRetryCount: 3,
            defaultQueryTimeoutMs: 120000, // 2 minutos
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            fireInitQueries: false,
            shouldSyncHistoryMessage: () => false,
            shouldIgnoreJid: () => false,
            getMessage: async (key) => {
                return null;
            },
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('[INFO] ✅ QR generado - escanea con WhatsApp');
                console.log('[QR] Código QR disponible en: http://localhost:3000/qr');
                lastQR = qr;
            }

            if (connection === 'close') {
                lastQR = '';
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const reason = DisconnectReason[statusCode] || 'desconocida';
                console.log(`🔌 Conexión cerrada: ${reason}`);
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada - elimina la carpeta session para reconectar');
                } else {
                    console.log('🔄 Reconectando en 15 segundos...');
                    setTimeout(() => startBot(), 15000);
                }
            } else if (connection === 'open') {
                lastQR = '';
                console.log('✅ ¡Bot conectado a WhatsApp!');
            } else if (connection === 'connecting') {
                console.log('🔄 Conectando a WhatsApp...');
            }
        });

    } catch (error) {
        console.error('[ERROR] Error al iniciar bot:', error);
        console.log('🔄 Reintentando en 20 segundos...');
        setTimeout(() => startBot(), 20000);
    }
}

// --- Endpoints ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, texto } = req.body;
    if (!numero || !texto) {
        return res.status(400).json({ error: 'El número y el texto son obligatorios' });
    }
    messageQueue.addMessage(numero, texto, res);
});

app.get('/estado-cola', (req, res) => {
    const status = messageQueue.getQueueStatus();
    const botConectado = sock && sock.ws && sock.ws.readyState === sock.ws.OPEN;
    const qrDisponible = !!lastQR;
    
    res.json({
        cola: status,
        botConectado: botConectado,
        qrDisponible: qrDisponible,
        estado: botConectado ? 'conectado' : (qrDisponible ? 'esperando_qr' : 'desconectado'),
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (lastQR) {
        try {
            const qrImage = await QRCode.toDataURL(lastQR);
            res.send(`
                <html>
                <head>
                    <title>QR Code - Bot WhatsApp</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        .qr-container { margin: 20px 0; }
                        .instructions { margin: 20px 0; color: #666; text-align: left; }
                        .status { background: #e8f5e8; padding: 15px; border-radius: 10px; margin: 20px 0; }
                        .btn { background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🤖 Bot WhatsApp</h1>
                        <div class="status">
                            <h3>✅ QR Disponible</h3>
                            <p>Escanea el código para conectar</p>
                        </div>
                        <div class="qr-container">
                            <img src="${qrImage}" alt="QR Code" style="width:300px;height:300px;border:3px solid #25D366;border-radius:10px;"/>
                        </div>
                        <div class="instructions">
                            <h3>📱 Instrucciones:</h3>
                            <ol>
                                <li>Abre WhatsApp en tu teléfono</li>
                                <li>Ve a <strong>Configuración</strong> → <strong>Dispositivos vinculados</strong></li>
                                <li>Toca <strong>"Vincular un dispositivo"</strong></li>
                                <li>Escanea este código QR</li>
                            </ol>
                        </div>
                        <a href="/estado-cola" class="btn">Ver Estado del Bot</a>
                    </div>
                </body>
                </html>
            `);
        } catch (err) {
            res.status(500).send('Error al generar la imagen del QR');
        }
    } else {
        res.send(`
            <html>
            <head>
                <title>QR Code - Bot WhatsApp</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .status { background: #fff3cd; padding: 15px; border-radius: 10px; margin: 20px 0; }
                    .btn { background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🤖 Bot WhatsApp</h1>
                    <div class="status">
                        <h3>⏳ Esperando QR</h3>
                        <p>El bot está intentando conectar con WhatsApp...</p>
                        <p>Espera unos segundos y recarga la página.</p>
                    </div>
                    <a href="/estado-cola" class="btn">Ver Estado del Bot</a>
                    <a href="/qr" class="btn">Recargar QR</a>
                </div>
            </body>
            </html>
        `);
    }
});

// --- Iniciar Servidor ---
app.listen(port, () => {
    console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
    console.log(`📱 Para conectar WhatsApp, ve a: http://localhost:${port}/qr`);
    console.log(`📊 Para ver el estado, ve a: http://localhost:${port}/estado-cola`);
    startBot();
});
