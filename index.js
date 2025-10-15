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
    console.log(`[INFO] Directorio de sesión creado: ${sessionDir}`);
}

let sock;
let lastQR = '';
let hasEverConnected = false;
let isConnecting = false;

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
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;
        console.log(`[COLA] Procesando cola. Mensajes pendientes: ${this.queue.length}`);

        while (this.queue.length > 0) {
            const messageData = this.queue.shift();
            await this.processMessage(messageData);
            
            // Pequeña pausa entre mensajes para evitar rate limit
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        this.processing = false;
        console.log('[COLA] Cola procesada completamente');
    }

    async processMessage(messageData) {
        const { numero, texto, res, attempts, maxAttempts, id } = messageData;
        
        console.log(`[COLA] Procesando mensaje ${id} (intento ${attempts + 1}/${maxAttempts})`);

        try {
            // Verificar conexión
            if (!sock || !sock.user) {
                throw new Error('Bot no conectado a WhatsApp');
            }

            if (sock.ws.readyState !== sock.ws.OPEN) {
                throw new Error('WebSocket no está abierto');
            }

            // Limpiar número (eliminar espacios, guiones, etc.)
            const cleanNumber = numero.replace(/\D/g, '');
            const jid = `${cleanNumber}@s.whatsapp.net`;
            
            console.log(`[COLA] Verificando existencia del número: ${cleanNumber}`);
            
            // Verificar si el número existe en WhatsApp
            const [result] = await sock.onWhatsApp(jid);
            
            if (!result?.exists) {
                throw new Error(`El número ${cleanNumber} no existe en WhatsApp`);
            }

            console.log(`[COLA] Enviando mensaje a ${cleanNumber}...`);
            
            // Envío del mensaje
            await sock.sendMessage(jid, { text: texto });
            
            console.log(`[COLA] ✅ Mensaje ${id} enviado exitosamente a ${cleanNumber}`);
            
            // Enviar respuesta exitosa
            if (this.pendingResponses.has(id)) {
                const response = this.pendingResponses.get(id);
                response.json({ 
                    success: true, 
                    message: `Mensaje enviado exitosamente a ${cleanNumber}`,
                    queueId: id,
                    attempts: attempts + 1,
                    timestamp: new Date().toISOString()
                });
                this.pendingResponses.delete(id);
            }

        } catch (error) {
            console.error(`[COLA] ❌ Error en mensaje ${id} (intento ${attempts + 1}):`, error.message);
            
            const newAttempts = attempts + 1;
            
            if (newAttempts < maxAttempts) {
                console.log(`[COLA] 🔄 Reintentando mensaje ${id} en 5 segundos...`);
                
                // Reagregar a la cola para reintento
                setTimeout(() => {
                    this.queue.push({
                        ...messageData,
                        attempts: newAttempts
                    });
                    if (!this.processing) {
                        this.processQueue();
                    }
                }, 5000);
                
            } else {
                console.error(`[COLA] ❌ Mensaje ${id} falló después de ${maxAttempts} intentos`);
                
                // Enviar respuesta de error
                if (this.pendingResponses.has(id)) {
                    const response = this.pendingResponses.get(id);
                    response.status(500).json({ 
                        success: false,
                        error: 'Error al enviar el mensaje después de múltiples intentos',
                        details: error.message,
                        queueId: id,
                        attempts: newAttempts,
                        timestamp: new Date().toISOString()
                    });
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
    if (isConnecting) {
        console.log('[INFO] Ya hay una conexión en proceso, saltando...');
        return;
    }

    isConnecting = true;
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
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            fireInitQueries: true,
            getMessage: async (key) => {
                return { conversation: '' };
            },
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`[DEBUG] Connection update: ${connection || 'undefined'}`);
            
            if (qr) {
                console.log('[INFO] ✅ Se recibió un nuevo QR.');
                console.log('[QR] Escanea este código con WhatsApp:');
                console.log(qr);
                lastQR = qr;
            }

            if (connection === 'close') {
                isConnecting = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log(`🔌 Conexión cerrada, código: ${statusCode}`);
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Sesión cerrada (logout). Elimina la carpeta session y reinicia.');
                    hasEverConnected = false;
                    lastQR = '';
                    
                    // Limpiar sesión
                    try {
                        if (fs.existsSync(sessionDir)) {
                            fs.rmSync(sessionDir, { recursive: true, force: true });
                            fs.mkdirSync(sessionDir, { recursive: true });
                            console.log('🗑️ Sesión eliminada. Reinicia el servidor para generar nuevo QR.');
                        }
                    } catch (err) {
                        console.error('Error al limpiar sesión:', err);
                    }
                } else if (shouldReconnect) {
                    console.log('🔄 Reconectando en 5 segundos...');
                    setTimeout(() => startBot(), 5000);
                } else {
                    console.log('❌ No se reconectará automáticamente.');
                }
            } else if (connection === 'open') {
                isConnecting = false;
                lastQR = '';
                hasEverConnected = true;
                console.log('✅ ¡Bot conectado a WhatsApp exitosamente!');
                console.log(`📱 Conectado como: ${sock.user?.id || 'Desconocido'}`);
            } else if (connection === 'connecting') {
                console.log('🔄 Conectando a WhatsApp...');
            }
        });

        // Manejar mensajes entrantes (opcional, para logs)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                console.log(`[MENSAJE] Recibido de ${msg.key.remoteJid}`);
            }
        });

    } catch (error) {
        isConnecting = false;
        console.error('[ERROR] Error al iniciar el bot:', error);
        console.log('🔄 Reintentando en 10 segundos...');
        setTimeout(() => startBot(), 10000);
    }
}

// --- Endpoints del Servidor ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, texto } = req.body;
    
    if (!numero || !texto) {
        return res.status(400).json({ 
            success: false,
            error: 'El número y el texto son obligatorios',
            ejemplo: {
                numero: "5491112345678",
                texto: "Hola, este es un mensaje de prueba"
            }
        });
    }

    // Verificar si el bot está conectado
    if (!sock || !sock.user) {
        return res.status(503).json({ 
            success: false,
            error: 'Bot no conectado a WhatsApp. Por favor escanea el QR en /qr',
            botStatus: 'disconnected'
        });
    }

    // Agregar mensaje a la cola
    messageQueue.addMessage(numero, texto, res);
});

app.get('/estado-cola', (req, res) => {
    const status = messageQueue.getQueueStatus();
    const botConectado = sock && sock.user && sock.ws && sock.ws.readyState === 1;
    const qrDisponible = !!lastQR;
    
    res.json({
        success: true,
        cola: status,
        botConectado: botConectado,
        qrDisponible: qrDisponible,
        estado: botConectado ? 'conectado' : (qrDisponible ? 'esperando_qr' : 'desconectado'),
        usuarioConectado: sock?.user?.id || null,
        timestamp: new Date().toISOString(),
        debug: {
            sockExists: !!sock,
            userExists: !!(sock && sock.user),
            wsExists: !!(sock && sock.ws),
            wsReadyState: sock && sock.ws ? sock.ws.readyState : 'N/A',
            wsReadyStateText: sock && sock.ws ? 
                (sock.ws.readyState === 0 ? 'CONNECTING' : 
                 sock.ws.readyState === 1 ? 'OPEN' : 
                 sock.ws.readyState === 2 ? 'CLOSING' : 
                 sock.ws.readyState === 3 ? 'CLOSED' : 'UNKNOWN') : 'N/A',
            hasEverConnected: hasEverConnected,
            isConnecting: isConnecting
        }
    });
});

app.get('/qr', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    
    const botConectado = sock && sock.user && sock.ws && sock.ws.readyState === 1;
    
    if (botConectado) {
        res.send(`
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Bot WhatsApp - Conectado</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .status { background: #d4edda; padding: 15px; border-radius: 10px; margin: 20px 0; border: 2px solid #28a745; }
                    .btn { background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; border: none; cursor: pointer; }
                    .info { background: #f8f9fa; padding: 15px; border-radius: 10px; margin: 20px 0; text-align: left; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🤖 Bot WhatsApp</h1>
                    <div class="status">
                        <h2>✅ BOT CONECTADO</h2>
                        <p style="font-size: 18px; margin: 10px 0;">📱 ${sock.user.id}</p>
                        <p style="color: #155724;">El bot está listo para enviar mensajes</p>
                    </div>
                    <div class="info">
                        <h3>📡 Estado del Servicio</h3>
                        <p><strong>Estado:</strong> Conectado y operativo</p>
                        <p><strong>Cola de mensajes:</strong> ${messageQueue.getQueueStatus().queueLength} pendientes</p>
                        <p><strong>Última actualización:</strong> ${new Date().toLocaleString('es-AR')}</p>
                    </div>
                    <a href="/estado-cola" class="btn">Ver Estado Detallado</a>
                    <button onclick="location.reload()" class="btn" style="background: #007bff;">Actualizar</button>
                </div>
            </body>
            </html>
        `);
    } else if (lastQR) {
        try {
            const qrImage = await QRCode.toDataURL(lastQR);
            res.send(`
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>QR Code - Bot WhatsApp</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
                        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        .qr-container { margin: 20px 0; }
                        .instructions { margin: 20px 0; color: #666; text-align: left; }
                        .status { background: #e8f5e8; padding: 15px; border-radius: 10px; margin: 20px 0; }
                        .btn { background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
                    </style>
                    <script>
                        // Auto-refresh cada 30 segundos
                        setTimeout(() => location.reload(), 30000);
                    </script>
                </head>
                <body>
                    <div class="container">
                        <h1>🤖 Bot WhatsApp</h1>
                        <div class="status">
                            <h3>✅ QR Disponible</h3>
                            <p>Escanea el código para conectar</p>
                            <p style="font-size: 12px; color: #888;">La página se actualizará automáticamente</p>
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
                        <a href="/qr" class="btn" style="background: #007bff;">Actualizar QR</a>
                    </div>
                </body>
                </html>
            `);
        } catch (err) {
            console.error('Error al generar QR:', err);
            res.status(500).send('Error al generar la imagen del QR');
        }
    } else {
        res.send(`
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>QR Code - Bot WhatsApp</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .status { background: #fff3cd; padding: 15px; border-radius: 10px; margin: 20px 0; }
                    .btn { background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
                    .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #25D366; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
                <script>
                    // Auto-refresh cada 10 segundos
                    setTimeout(() => location.reload(), 10000);
                </script>
            </head>
            <body>
                <div class="container">
                    <h1>🤖 Bot WhatsApp</h1>
                    <div class="status">
                        <h3>⏳ Generando QR</h3>
                        <div class="spinner"></div>
                        <p>El bot está intentando conectar con WhatsApp...</p>
                        <p>Espera unos segundos, la página se recargará automáticamente.</p>
                        <p style="font-size: 12px; color: #888; margin-top: 15px;">Si después de 1 minuto no aparece el QR, verifica los logs del servidor.</p>
                    </div>
                    <a href="/estado-cola" class="btn">Ver Estado del Bot</a>
                    <a href="/qr" class="btn" style="background: #007bff;">Recargar Ahora</a>
                </div>
            </body>
            </html>
        `);
    }
});

// Ruta de health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Ruta principal
app.get('/', (req, res) => {
    res.redirect('/qr');
});

// --- Iniciar Servidor y Bot ---
app.listen(port, () => {
    console.log(`🚀 Servidor Express escuchando en el puerto ${port}`);
    console.log(`📱 Accede a http://localhost:${port}/qr para ver el código QR`);
    console.log(`📊 Estado del bot: http://localhost:${port}/estado-cola`);
    startBot();
});