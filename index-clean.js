// Bot WhatsApp con sistema de cola - Versión limpia para primera conexión
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
            // Verificar conexión
            if (!sock || sock.ws.readyState !== sock.ws.OPEN) {
                throw new Error('Bot no conectado a WhatsApp');
            }

            const jid = `${numero}@s.whatsapp.net`;
            const [result] = await sock.onWhatsApp(jid);
            
            if (!result?.exists) {
                throw new Error('El número no existe en WhatsApp');
            }

            // Envío directo del mensaje
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
                
                // Reagregar a la cola para reintento
                setTimeout(() => {
                    this.queue.unshift({
                        ...messageData,
                        attempts: newAttempts
                    });
                    this.processQueue();
                }, 10000); // 10 segundos
                
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
const IS_RENDER = process.env.RENDER === 'true';
const sessionDir = IS_RENDER ? '/data/session' : path.join(__dirname, 'session');

console.log(`[INFO] Entorno de Render detectado: ${IS_RENDER}`);
console.log(`[INFO] Usando directorio de sesión: ${sessionDir}`);

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
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 5,
            defaultQueryTimeoutMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('[INFO] Se recibió un nuevo QR.');
                console.log('[QR] Escanea este código con WhatsApp:');
                console.log(qr);
                lastQR = qr;
            }

            if (connection === 'close') {
                lastQR = '';
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const reason = DisconnectReason[statusCode] || 'desconocida';
                console.log(`🔌 Conexión cerrada, razón: ${reason}`);
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Conexión cerrada permanentemente por logout.');
                    console.log('💡 Elimina la carpeta session y reinicia para generar nuevo QR');
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log('🔄 Reinicio requerido, reconectando...');
                    setTimeout(() => startBot(), 5000);
                } else if (statusCode === DisconnectReason.timedOut) {
                    console.log('⏰ Timeout de conexión, reintentando...');
                    setTimeout(() => startBot(), 10000);
                } else {
                    console.log('🔄 Intentando reconectar en 10 segundos...');
                    setTimeout(() => startBot(), 10000);
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
        setTimeout(() => startBot(), 10000);
    }
}

// --- Endpoints del Servidor ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, texto } = req.body;
    if (!numero || !texto) {
        return res.status(400).json({ error: 'El número y el texto son obligatorios' });
    }

    // Agregar mensaje a la cola (no se guarda en memoria, se procesa directamente)
    messageQueue.addMessage(numero, texto, res);
});

// Endpoint para verificar el estado de la cola
app.get('/estado-cola', (req, res) => {
    const status = messageQueue.getQueueStatus();
    res.json({
        cola: status,
        botConectado: sock && sock.ws.readyState === sock.ws.OPEN
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
                        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
                        .qr-container { margin: 20px 0; }
                        .instructions { margin: 20px 0; color: #666; }
                    </style>
                </head>
                <body>
                    <h1>🤖 Bot WhatsApp - Conexión</h1>
                    <div class="qr-container">
                        <img src="${qrImage}" alt="Escanea este código QR" style="width:300px;height:300px;border:2px solid #25D366;"/>
                    </div>
                    <div class="instructions">
                        <h3>📱 Instrucciones:</h3>
                        <p>1. Abre WhatsApp en tu teléfono</p>
                        <p>2. Ve a Configuración > Dispositivos vinculados</p>
                        <p>3. Toca "Vincular un dispositivo"</p>
                        <p>4. Escanea este código QR</p>
                    </div>
                    <p><strong>Estado:</strong> Esperando conexión...</p>
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
                    body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
                    .status { margin: 20px 0; padding: 20px; background: #f0f0f0; border-radius: 10px; }
                </style>
            </head>
            <body>
                <h1>🤖 Bot WhatsApp</h1>
                <div class="status">
                    <h2>No hay un código QR disponible</h2>
                    <p>Si el bot está conectado, no se mostrará ningún QR.</p>
                    <p>Si no está conectado, espera unos segundos para que se genere el QR.</p>
                </div>
                <p><a href="/estado-cola">Ver estado del bot</a></p>
            </body>
            </html>
        `);
    }
});

// --- Iniciar Servidor y Bot ---
app.listen(port, () => {
    console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
    console.log(`📱 Para conectar WhatsApp, ve a: http://localhost:${port}/qr`);
    startBot();
});
