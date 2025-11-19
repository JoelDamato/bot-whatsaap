// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// Discord Webhook URL
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1440761165906051184/xpk8PxG-GBaqAhDAA8i5vfFpH-w_CLrc1CGySAMSUHtaPRbLXXaxxsvhkUtizGIKSsbK';

// --- Función para enviar notificaciones a Discord ---
async function sendDiscordNotification(type, message, details = {}) {
    try {
        const colors = {
            error: 15158332, // Rojo
            warning: 16776960, // Amarillo
            success: 3066993, // Verde
            info: 3447003 // Azul
        };

        const embed = {
            title: `🤖 WhatsApp Bot - ${type.toUpperCase()}`,
            description: message,
            color: colors[type] || colors.info,
            fields: Object.entries(details).map(([key, value]) => ({
                name: key,
                value: String(value),
                inline: true
            })),
            timestamp: new Date().toISOString(),
            footer: { text: 'WhatsApp Bot Monitor' }
        };

        await axios.post(DISCORD_WEBHOOK_URL, { embeds: [embed] });
        console.log(`[DISCORD] Notificación enviada: ${type}`);
    } catch (error) {
        console.error('[DISCORD] Error al enviar notificación:', error.message);
    }
}

// --- Lógica de sesión ---
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

// Historial de mensajes enviados
const sentMessagesHistory = [];
const MAX_HISTORY = 100;

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
            if (!sock || !sock.user) {
                throw new Error('Bot no conectado a WhatsApp');
            }

            const cleanNumber = numero.replace(/\D/g, '');
            const jid = `${cleanNumber}@s.whatsapp.net`;

            const [result] = await sock.onWhatsApp(jid);
            if (!result?.exists) {
                throw new Error(`El número ${cleanNumber} no existe en WhatsApp`);
            }

            await sock.sendMessage(jid, { text: texto });

            console.log(`[COLA] ✅ Mensaje enviado a ${cleanNumber}`);

            // Guardar en historial
            sentMessagesHistory.unshift({
                numero: cleanNumber,
                texto: texto.substring(0, 100) + (texto.length > 100 ? '...' : ''),
                timestamp: new Date().toISOString(),
                id,
                status: 'enviado'
            });

            if (sentMessagesHistory.length > MAX_HISTORY) {
                sentMessagesHistory.pop();
            }

            if (this.pendingResponses.has(id)) {
                const response = this.pendingResponses.get(id);
                response.json({ success: true, message: `Mensaje enviado a ${cleanNumber}`, queueId: id });
                this.pendingResponses.delete(id);
            }

        } catch (error) {
            console.error(`[COLA] ❌ Error mensaje ${id}:`, error.message);

            // Notificar error crítico a Discord
            if (error.message.includes('no conectado')) {
                await sendDiscordNotification('error', 'Error al enviar mensaje', {
                    'Error': error.message,
                    'Número': numero,
                    'ID Mensaje': id
                });
            }

            const newAttempts = attempts + 1;

            if (newAttempts < maxAttempts) {
                setTimeout(() => {
                    this.queue.push({ ...messageData, attempts: newAttempts });
                    if (!this.processing) this.processQueue();
                }, 5000);
            } else {
                // Guardar error en historial
                sentMessagesHistory.unshift({
                    numero: numero.replace(/\D/g, ''),
                    texto: texto.substring(0, 100) + (texto.length > 100 ? '...' : ''),
                    timestamp: new Date().toISOString(),
                    id,
                    status: 'error',
                    error: error.message
                });

                if (sentMessagesHistory.length > MAX_HISTORY) {
                    sentMessagesHistory.pop();
                }

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
                
                if (!hasEverConnected) {
                    await sendDiscordNotification('info', 'Nuevo QR generado', {
                        'Estado': 'Esperando escaneo'
                    });
                }
            }

            if (connection === 'open') {
                isConnecting = false;
                lastQR = '';
                hasEverConnected = true;
                reconnectAttempts = 0;
                console.log('✅ Bot conectado a WhatsApp');

                await sendDiscordNotification('success', 'Bot conectado exitosamente', {
                    'Usuario': sock.user.id,
                    'Timestamp': new Date().toISOString()
                });
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[INFO] Conexión cerrada. Código: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('⚠️ Sesión cerrada remotamente');
                    
                    await sendDiscordNotification('warning', 'Sesión cerrada remotamente', {
                        'Razón': 'Logout desde WhatsApp',
                        'Acción': 'Limpiando sesión y generando nuevo QR'
                    });

                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    fs.mkdirSync(sessionDir, { recursive: true });
                    hasEverConnected = false;
                    setTimeout(startBot, 2000);
                } else {
                    console.log('🔄 Reconectando en 5s…');
                    
                    await sendDiscordNotification('warning', 'Desconexión detectada', {
                        'Código': statusCode || 'Desconocido',
                        'Acción': 'Reintentando conexión'
                    });

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
        
        await sendDiscordNotification('error', 'Error al iniciar bot', {
            'Error': error.message,
            'Stack': error.stack?.substring(0, 200)
        });

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
        console.log('[INFO] Limpiando sesión manualmente...');
        
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                console.log('[WARN] No se pudo hacer logout:', e.message);
            }
        }

        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        lastQR = '';
        hasEverConnected = false;

        await sendDiscordNotification('info', 'Sesión limpiada manualmente', {
            'Acción': 'Usuario solicitó limpiar sesión',
            'Estado': 'Generando nuevo QR'
        });

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

app.get('/historial-mensajes', (req, res) => {
    res.json({
        success: true,
        total: sentMessagesHistory.length,
        mensajes: sentMessagesHistory
    });
});

app.get('/qr', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');

    const botConectado = sock && sock.user;
    let qrImage = '';

    if (lastQR) {
        qrImage = await QRCode.toDataURL(lastQR);
    }

    const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Bot Dashboard</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
            }

            .container {
                max-width: 1200px;
                margin: 0 auto;
            }

            .header {
                text-align: center;
                color: white;
                margin-bottom: 30px;
            }

            .header h1 {
                font-size: 2.5em;
                margin-bottom: 10px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
            }

            .header p {
                font-size: 1.1em;
                opacity: 0.9;
            }

            .dashboard {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
                gap: 20px;
                margin-bottom: 20px;
            }

            .card {
                background: white;
                border-radius: 15px;
                padding: 25px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                transition: transform 0.3s ease;
            }

            .card:hover {
                transform: translateY(-5px);
            }

            .card h2 {
                color: #333;
                margin-bottom: 20px;
                font-size: 1.5em;
                border-bottom: 3px solid #667eea;
                padding-bottom: 10px;
            }

            .status-indicator {
                display: inline-block;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                margin-right: 8px;
                animation: pulse 2s infinite;
            }

            .status-connected {
                background-color: #10b981;
            }

            .status-disconnected {
                background-color: #ef4444;
            }

            .status-waiting {
                background-color: #f59e0b;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            .qr-container {
                text-align: center;
                padding: 20px;
            }

            .qr-container img {
                max-width: 100%;
                border-radius: 10px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            }

            .connected-info {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                padding: 30px;
                border-radius: 10px;
                text-align: center;
            }

            .connected-info h3 {
                font-size: 2em;
                margin-bottom: 10px;
            }

            .btn {
                display: inline-block;
                padding: 12px 30px;
                border: none;
                border-radius: 8px;
                font-size: 1em;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                text-decoration: none;
                margin: 5px;
            }

            .btn-danger {
                background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                color: white;
            }

            .btn-danger:hover {
                transform: scale(1.05);
                box-shadow: 0 5px 15px rgba(239, 68, 68, 0.4);
            }

            .btn-primary {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }

            .btn-primary:hover {
                transform: scale(1.05);
                box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
            }

            .messages-list {
                max-height: 400px;
                overflow-y: auto;
                margin-top: 15px;
            }

            .message-item {
                background: #f3f4f6;
                padding: 15px;
                border-radius: 8px;
                margin-bottom: 10px;
                border-left: 4px solid #667eea;
            }

            .message-item.error {
                border-left-color: #ef4444;
                background: #fee2e2;
            }

            .message-item .message-number {
                font-weight: bold;
                color: #667eea;
                margin-bottom: 5px;
            }

            .message-item .message-text {
                color: #4b5563;
                margin-bottom: 5px;
                font-size: 0.9em;
            }

            .message-item .message-time {
                color: #9ca3af;
                font-size: 0.8em;
            }

            .message-item .message-status {
                display: inline-block;
                padding: 3px 8px;
                border-radius: 12px;
                font-size: 0.75em;
                font-weight: bold;
                margin-top: 5px;
            }

            .status-enviado {
                background: #d1fae5;
                color: #065f46;
            }

            .status-error {
                background: #fee2e2;
                color: #991b1b;
            }

            .info-item {
                display: flex;
                justify-content: space-between;
                padding: 10px 0;
                border-bottom: 1px solid #e5e7eb;
            }

            .info-item:last-child {
                border-bottom: none;
            }

            .info-label {
                font-weight: bold;
                color: #6b7280;
            }

            .info-value {
                color: #111827;
            }

            .loading {
                text-align: center;
                color: #6b7280;
                font-style: italic;
            }

            .actions {
                display: flex;
                gap: 10px;
                justify-content: center;
                flex-wrap: wrap;
                margin-top: 20px;
            }

            @media (max-width: 768px) {
                .dashboard {
                    grid-template-columns: 1fr;
                }
                
                .header h1 {
                    font-size: 1.8em;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🤖 WhatsApp Bot Dashboard</h1>
                <p>Panel de control y monitoreo</p>
            </div>

            <div class="dashboard">
                <!-- Card de Conexión -->
                <div class="card">
                    <h2>
                        <span class="status-indicator ${botConectado ? 'status-connected' : (lastQR ? 'status-waiting' : 'status-disconnected')}"></span>
                        Estado de Conexión
                    </h2>
                    
                    ${botConectado ? `
                        <div class="connected-info">
                            <h3>✅ Conectado</h3>
                            <p style="margin-top: 10px; font-size: 0.9em;">Usuario: <strong>${sock.user.id}</strong></p>
                        </div>
                    ` : (lastQR ? `
                        <div class="qr-container">
                            <p style="color: #f59e0b; font-weight: bold; margin-bottom: 15px;">📱 Escanea el código QR</p>
                            <img src="${qrImage}" alt="QR Code" />
                            <p style="color: #6b7280; margin-top: 15px; font-size: 0.9em;">Abre WhatsApp y escanea este código</p>
                        </div>
                    ` : `
                        <div class="loading">
                            <p>⏳ Generando código QR...</p>
                            <p style="margin-top: 10px; font-size: 0.9em;">Por favor espera unos segundos</p>
                        </div>
                    `)}

                    <div class="actions">
                        <button class="btn btn-danger" onclick="limpiarSesion()">🗑️ Limpiar Sesión</button>
                        <button class="btn btn-primary" onclick="location.reload()">🔄 Actualizar</button>
                    </div>
                </div>

                <!-- Card de Estado del Sistema -->
                <div class="card">
                    <h2>📊 Estado del Sistema</h2>
                    <div id="systemStatus">
                        <div class="loading">Cargando información...</div>
                    </div>
                </div>

                <!-- Card de Últimos Mensajes -->
                <div class="card" style="grid-column: span 1;">
                    <h2>📨 Últimos Mensajes</h2>
                    <div id="messagesList">
                        <div class="loading">Cargando mensajes...</div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            async function limpiarSesion() {
                if (!confirm('¿Estás seguro de que quieres limpiar la sesión? Deberás escanear un nuevo QR.')) {
                    return;
                }

                try {
                    const response = await fetch('/limpiar-sesion', { method: 'POST' });
                    const data = await response.json();
                    
                    if (data.success) {
                        alert('✅ Sesión limpiada correctamente');
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        alert('❌ Error: ' + data.error);
                    }
                } catch (error) {
                    alert('❌ Error al limpiar sesión: ' + error.message);
                }
            }

            async function cargarEstadoSistema() {
                try {
                    const response = await fetch('/estado-cola');
                    const data = await response.json();

                    const statusHtml = \`
                        <div class="info-item">
                            <span class="info-label">Estado del Bot:</span>
                            <span class="info-value">\${data.botConectado ? '🟢 Conectado' : '🔴 Desconectado'}</span>
                        </div>
                        <div class="info-item">
                            <span class="info-label">Mensajes en Cola:</span>
                            <span class="info-value">\${data.cola.queueLength}</span>
                        </div>
                        <div class="info-item">
                            <span class="info-label">Procesando:</span>
                            <span class="info-value">\${data.cola.processing ? '✅ Sí' : '❌ No'}</span>
                        </div>
                        <div class="info-item">
                            <span class="info-label">Respuestas Pendientes:</span>
                            <span class="info-value">\${data.cola.pendingResponses}</span>
                        </div>
                    \`;

                    document.getElementById('systemStatus').innerHTML = statusHtml;
                } catch (error) {
                    document.getElementById('systemStatus').innerHTML = '<div class="loading" style="color: #ef4444;">Error al cargar estado</div>';
                }
            }

            async function cargarMensajes() {
                try {
                    const response = await fetch('/historial-mensajes');
                    const data = await response.json();

                    if (data.mensajes.length === 0) {
                        document.getElementById('messagesList').innerHTML = '<div class="loading">No hay mensajes aún</div>';
                        return;
                    }

                    const messagesHtml = data.mensajes.slice(0, 10).map(msg => \`
                        <div class="message-item \${msg.status === 'error' ? 'error' : ''}">
                            <div class="message-number">📱 \${msg.numero}</div>
                            <div class="message-text">\${msg.texto}</div>
                            <div class="message-time">🕐 \${new Date(msg.timestamp).toLocaleString('es-AR')}</div>
                            <span class="message-status status-\${msg.status}">
                                \${msg.status === 'enviado' ? '✅ Enviado' : '❌ Error'}
                            </span>
                            \${msg.error ? \`<div style="color: #ef4444; font-size: 0.8em; margin-top: 5px;">\${msg.error}</div>\` : ''}
                        </div>
                    \`).join('');

                    document.getElementById('messagesList').innerHTML = \`
                        <div class="messages-list">\${messagesHtml}</div>
                        <p style="text-align: center; color: #6b7280; margin-top: 15px; font-size: 0.9em;">
                            Mostrando \${Math.min(10, data.mensajes.length)} de \${data.total} mensajes
                        </p>
                    \`;
                } catch (error) {
                    document.getElementById('messagesList').innerHTML = '<div class="loading" style="color: #ef4444;">Error al cargar mensajes</div>';
                }
            }

            // Cargar datos iniciales
            cargarEstadoSistema();
            cargarMensajes();

            // Actualizar cada 5 segundos
            setInterval(() => {
                cargarEstadoSistema();
                cargarMensajes();
            }, 5000);
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: !!sock?.user });
});

app.get('/', (req, res) => res.redirect('/qr'));

// --- Iniciar servidor y bot ---
app.listen(port, async () => {
    console.log(`🚀 Servidor Express en puerto ${port}`);
    
    await sendDiscordNotification('info', 'Servidor iniciado', {
        'Puerto': port,
        'Timestamp': new Date().toISOString()
    });
    
    startBot();
});