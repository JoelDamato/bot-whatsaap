// index.js - WhatsApp Bot Mejorado con seguimiento de estados
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const sharp = require('sharp');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// Discord Webhook URL - MOVER A VARIABLE DE ENTORNO
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1440761165906051184/xpk8PxG-GBaqAhDAA8i5vfFpH-w_CLrc1CGySAMSUHtaPRbLXXaxxsvhkUtizGIKSsbK';

// --- Función para enviar notificaciones a Discord ---
async function sendDiscordNotification(type, message, details = {}) {
    try {
        const colors = {
            error: 15158332,
            warning: 16776960,
            success: 3066993,
            info: 3447003
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
const MAX_RECONNECT_ATTEMPTS = 10;

// Historial de mensajes enviados con estados mejorados
const sentMessagesHistory = [];
const MAX_HISTORY = 500;

// Historial de grupos creados
const gruposHistory = [];
const MAX_GROUPS_HISTORY = 100;

// Map para tracking de estados de mensajes
const messageStatusMap = new Map();

// --- Sistema de Cola de Mensajes Mejorado ---
class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.pendingResponses = new Map();
        this.maxConcurrent = 1;
    }

    async addMessage(numero, texto, res) {
        const messageData = {
            numero,
            texto,
            res,
            attempts: 0,
            maxAttempts: 5,
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            status: 'en_cola'
        };
        
        this.queue.push(messageData);
        this.pendingResponses.set(messageData.id, res);
        
        // Agregar al historial inmediatamente
        sentMessagesHistory.unshift({
            numero: numero.replace(/\D/g, ''),
            texto: texto.substring(0, 100) + (texto.length > 100 ? '...' : ''),
            timestamp: messageData.timestamp,
            id: messageData.id,
            status: 'en_cola',
            statusIcon: '⏳',
            statusText: 'En cola'
        });
        
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
            
            // Delay de 3 segundos entre mensajes para evitar rate limiting
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        this.processing = false;
        console.log('[COLA] Cola procesada completamente');
    }

    async processMessage(messageData) {
        const { numero, texto, attempts, maxAttempts, id } = messageData;

        console.log(`[COLA] Procesando mensaje ${id} (intento ${attempts + 1}/${maxAttempts})`);

        // Actualizar estado a "enviando"
        this.updateMessageStatus(id, 'enviando', '📤', 'Enviando');

        try {
            if (!sock || !sock.user) {
                throw new Error('Bot no conectado a WhatsApp');
            }

            const cleanNumber = numero.replace(/\D/g, '');
            const jid = `${cleanNumber}@s.whatsapp.net`;

            // Verificar que el número existe
            const [result] = await sock.onWhatsApp(jid);
            if (!result?.exists) {
                throw new Error(`El número ${cleanNumber} no existe en WhatsApp`);
            }

            // Delay antes de enviar
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Enviar mensaje
            const sendResult = await sock.sendMessage(jid, { 
                text: texto 
            }, {
                ephemeralExpiration: 0
            });

            // Guardar el messageId para tracking
            const messageId = sendResult?.key?.id;
            messageStatusMap.set(messageId, id);

            console.log(`[COLA] ✅ Mensaje enviado a ${cleanNumber}`, sendResult);

            // Actualizar estado a "enviado"
            this.updateMessageStatus(id, 'enviado', '✅', 'Enviado', messageId);

            // Esperar un momento para confirmación
            await new Promise(resolve => setTimeout(resolve, 1000));

            if (this.pendingResponses.has(id)) {
                const response = this.pendingResponses.get(id);
                response.json({ 
                    success: true, 
                    message: `Mensaje enviado a ${cleanNumber}`, 
                    queueId: id,
                    messageId: messageId,
                    status: 'enviado'
                });
                this.pendingResponses.delete(id);
            }

        } catch (error) {
            console.error(`[COLA] ❌ Error mensaje ${id}:`, error.message);

            if (error.message.includes('no conectado')) {
                await sendDiscordNotification('error', 'Error al enviar mensaje', {
                    'Error': error.message,
                    'Número': numero,
                    'ID Mensaje': id
                });
            }

            const newAttempts = attempts + 1;

            if (newAttempts < maxAttempts) {
                console.log(`[COLA] 🔄 Reintentando mensaje ${id} en 10 segundos...`);
                
                // Actualizar estado a "reintentando"
                this.updateMessageStatus(id, 'reintentando', '🔄', `Reintentando (${newAttempts}/${maxAttempts})`);
                
                setTimeout(() => {
                    this.queue.push({ ...messageData, attempts: newAttempts });
                    if (!this.processing) this.processQueue();
                }, 10000);
            } else {
                // Error final
                this.updateMessageStatus(id, 'error', '❌', 'Error al enviar', null, error.message);

                if (this.pendingResponses.has(id)) {
                    const response = this.pendingResponses.get(id);
                    response.status(500).json({ 
                        success: false, 
                        error: error.message, 
                        queueId: id,
                        status: 'error'
                    });
                    this.pendingResponses.delete(id);
                }
            }
        }
    }

    updateMessageStatus(id, status, icon, statusText, messageId = null, error = null) {
        const messageIndex = sentMessagesHistory.findIndex(msg => msg.id === id);
        
        if (messageIndex !== -1) {
            sentMessagesHistory[messageIndex].status = status;
            sentMessagesHistory[messageIndex].statusIcon = icon;
            sentMessagesHistory[messageIndex].statusText = statusText;
            sentMessagesHistory[messageIndex].lastUpdate = new Date().toISOString();
            
            if (messageId) {
                sentMessagesHistory[messageIndex].messageId = messageId;
            }
            
            if (error) {
                sentMessagesHistory[messageIndex].error = error;
            }
        }

        if (sentMessagesHistory.length > MAX_HISTORY) {
            sentMessagesHistory.pop();
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
            markOnlineOnConnect: true,
            syncFullHistory: false,
            defaultQueryTimeoutMs: 60000,
            getMessage: async (key) => {
                return { conversation: '' }
            },
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 3,
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

        // Escuchar actualizaciones de mensajes para tracking de estado
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                const messageId = update.key.id;
                const internalId = messageStatusMap.get(messageId);
                
                if (internalId) {
                    // Actualizar estado según el update
                    if (update.update.status === 3) {
                        // Entregado
                        messageQueue.updateMessageStatus(internalId, 'entregado', '✅✅', 'Entregado', messageId);
                        console.log(`[STATUS] Mensaje ${messageId} entregado`);
                    } else if (update.update.status === 4) {
                        // Leído
                        messageQueue.updateMessageStatus(internalId, 'leido', '✅✅✅', 'Leído', messageId);
                        console.log(`[STATUS] Mensaje ${messageId} leído`);
                    }
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

app.post('/crear-grupo', async (req, res) => {
    try {
        const { numeros, imagen, nombre } = req.body;

        if (!sock || !sock.user) {
            return res.status(503).json({ 
                success: false, 
                error: 'Bot desconectado. Escaneá el QR.' 
            });
        }

        const nombreGrupo = (nombre && typeof nombre === 'string' && nombre.trim().length > 0) 
            ? nombre.trim() 
            : 'test grupos';

        if (nombreGrupo.length > 25) {
            return res.status(400).json({ 
                success: false, 
                error: 'El nombre del grupo no puede tener más de 25 caracteres' 
            });
        }

        if (!numeros || !Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Debes enviar un array de números (máximo 10)' 
            });
        }

        if (numeros.length > 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Máximo 10 números permitidos' 
            });
        }

        const numerosInvalidosFormato = numeros.filter(num => 
            typeof num !== 'string' || num.trim().length === 0
        );
        
        if (numerosInvalidosFormato.length > 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Todos los números deben ser strings no vacíos' 
            });
        }

        console.log(`[GRUPO] Creando grupo con ${numeros.length} participantes...`);

        const numerosLimpios = numeros.map(num => {
            const clean = num.replace(/\D/g, '');
            if (clean.length < 10) {
                throw new Error(`Número inválido: ${num} (debe tener al menos 10 dígitos)`);
            }
            return `${clean}@s.whatsapp.net`;
        });

        let verificaciones;
        try {
            verificaciones = await Promise.all(
                numerosLimpios.map(jid => sock.onWhatsApp(jid))
            );
        } catch (verifyError) {
            console.error('[GRUPO] ❌ Error al verificar números:', verifyError);
            return res.status(500).json({ 
                success: false, 
                error: 'Error al verificar números en WhatsApp: ' + verifyError.message 
            });
        }

        const numerosValidos = [];
        const numerosInvalidos = [];

        verificaciones.forEach((result, index) => {
            const checkResult = Array.isArray(result) ? result[0] : result;
            if (checkResult?.exists) {
                numerosValidos.push(numerosLimpios[index]);
            } else {
                const numeroOriginal = numeros[index];
                numerosInvalidos.push(numeroOriginal);
            }
        });

        if (numerosInvalidos.length > 0) {
            console.log(`[GRUPO] ⚠️ Números inválidos: ${numerosInvalidos.join(', ')}`);
        }

        if (numerosValidos.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Ninguno de los números existe en WhatsApp',
                numerosInvalidos: numerosInvalidos
            });
        }

        let grupoId;
        try {
            grupoId = await sock.groupCreate(nombreGrupo, numerosValidos);
            console.log(`[GRUPO] ✅ Grupo creado: ${grupoId} con nombre: ${nombreGrupo}`);
        } catch (createError) {
            console.error('[GRUPO] ❌ Error al crear el grupo:', createError);
            
            await sendDiscordNotification('error', 'Error al crear grupo', {
                'Error': createError.message,
                'Participantes intentados': numerosValidos.length
            });

            return res.status(500).json({ 
                success: false, 
                error: 'Error al crear el grupo: ' + (createError.message || 'Error desconocido'),
                detalles: createError.toString()
            });
        }

        try {
            await sock.groupUpdateSubject(grupoId, nombreGrupo);
        } catch (nameError) {
            console.log(`[GRUPO] ⚠️ El nombre ya estaba establecido:`, nameError.message);
        }

        const grupoInfo = {
            grupoId: grupoId,
            nombre: nombreGrupo,
            participantesAgregados: numerosValidos.length,
            numerosInvalidos: numerosInvalidos.length > 0 ? numerosInvalidos : [],
            timestamp: new Date().toISOString(),
            tieneImagen: !!imagen,
            status: 'creado'
        };

        if (imagen) {
            try {
                let imageBuffer;
                
                if (typeof imagen !== 'string' || imagen.trim().length === 0) {
                    throw new Error('La imagen debe ser una URL o string base64 válido');
                }
                
                if (imagen.startsWith('http://') || imagen.startsWith('https://')) {
                    console.log(`[GRUPO] Descargando imagen desde URL: ${imagen}`);
                    try {
                        const response = await axios.get(imagen, { 
                            responseType: 'arraybuffer',
                            timeout: 30000,
                            maxContentLength: 10 * 1024 * 1024,
                            maxBodyLength: 10 * 1024 * 1024,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            }
                        });
                        imageBuffer = Buffer.from(response.data);
                        
                        if (imageBuffer.length === 0) {
                            throw new Error('La imagen descargada está vacía');
                        }
                        
                        console.log(`[GRUPO] Imagen descargada: ${imageBuffer.length} bytes`);
                    } catch (downloadError) {
                        throw new Error(`Error al descargar imagen: ${downloadError.message}`);
                    }
                } 
                else if (imagen.startsWith('data:image')) {
                    const base64Data = imagen.split(',')[1] || imagen;
                    imageBuffer = Buffer.from(base64Data, 'base64');
                }
                else {
                    imageBuffer = Buffer.from(imagen, 'base64');
                }

                try {
                    console.log(`[GRUPO] Procesando imagen con sharp...`);
                    
                    const processedImage = await sharp(imageBuffer)
                        .resize(640, 640, {
                            fit: 'cover',
                            position: 'center'
                        })
                        .jpeg({ 
                            quality: 90,
                            mozjpeg: true 
                        })
                        .toBuffer();
                    
                    console.log(`[GRUPO] Imagen procesada: ${processedImage.length} bytes`);
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    await sock.updateProfilePicture(grupoId, processedImage);
                    console.log(`[GRUPO] ✅ Foto del grupo establecida`);
                    grupoInfo.imagenEstablecida = true;
                } catch (picError) {
                    throw new Error(`Error al establecer foto del grupo: ${picError.message}`);
                }
            } catch (imgError) {
                console.error(`[GRUPO] ⚠️ Error al establecer imagen:`, imgError);
                grupoInfo.errorImagen = imgError.message;
                grupoInfo.imagenEstablecida = false;
                
                await sendDiscordNotification('warning', 'Grupo creado pero error con imagen', {
                    'Grupo ID': grupoId,
                    'Error imagen': imgError.message
                });
            }
        }

        gruposHistory.unshift(grupoInfo);
        if (gruposHistory.length > MAX_GROUPS_HISTORY) {
            gruposHistory.pop();
        }

        try {
            await sendDiscordNotification('success', 'Grupo creado exitosamente', {
                'Grupo ID': grupoId,
                'Participantes': numerosValidos.length,
                'Números inválidos': numerosInvalidos.length > 0 ? numerosInvalidos.join(', ') : 'Ninguno'
            });
        } catch (discordError) {
            console.error('[GRUPO] ⚠️ Error al notificar a Discord:', discordError.message);
        }

        let mensajeRespuesta = 'Grupo creado exitosamente';
        if (grupoInfo.errorImagen) {
            mensajeRespuesta += '. Nota: Hubo un problema al establecer la imagen.';
        }

        res.json({ 
            success: true, 
            message: mensajeRespuesta,
            grupoId: grupoId,
            participantesAgregados: numerosValidos.length,
            numerosInvalidos: numerosInvalidos.length > 0 ? numerosInvalidos : undefined,
            imagenEstablecida: grupoInfo.imagenEstablecida || false,
            errorImagen: grupoInfo.errorImagen || undefined
        });

    } catch (error) {
        console.error('[GRUPO] ❌ Error al crear grupo:', error);
        
        sendDiscordNotification('error', 'Error al crear grupo', {
            'Error': error.message,
            'Stack': error.stack?.substring(0, 200)
        }).catch(err => console.error('[GRUPO] Error Discord:', err.message));

        res.status(500).json({ 
            success: false, 
            error: error.message || 'Error al crear el grupo',
            tipo: error.name || 'Error desconocido'
        });
    }
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

app.get('/api/grupos', (req, res) => {
    res.json({
        success: true,
        total: gruposHistory.length,
        grupos: gruposHistory,
        botConectado: sock && sock.user
    });
});

app.get('/grupos', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');

    const botConectado = sock && sock.user;

    const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Panel de Grupos - WhatsApp Bot</title>
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
                max-width: 1400px;
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
                grid-template-columns: 1fr 2fr;
                gap: 20px;
                margin-bottom: 20px;
            }

            @media (max-width: 968px) {
                .dashboard {
                    grid-template-columns: 1fr;
                }
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

            .form-group {
                margin-bottom: 20px;
            }

            .form-group label {
                display: block;
                margin-bottom: 8px;
                color: #333;
                font-weight: bold;
            }

            .form-group input,
            .form-group textarea {
                width: 100%;
                padding: 12px;
                border: 2px solid #e5e7eb;
                border-radius: 8px;
                font-size: 1em;
                transition: border-color 0.3s;
            }

            .form-group input:focus,
            .form-group textarea:focus {
                outline: none;
                border-color: #667eea;
            }

            .form-group textarea {
                resize: vertical;
                min-height: 80px;
            }

            .form-group small {
                display: block;
                margin-top: 5px;
                color: #6b7280;
                font-size: 0.85em;
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
                width: 100%;
            }

            .btn-success {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
            }

            .btn-success:hover {
                transform: scale(1.02);
                box-shadow: 0 5px 15px rgba(16, 185, 129, 0.4);
            }

            .btn-success:disabled {
                background: #9ca3af;
                cursor: not-allowed;
                transform: none;
            }

            .btn-primary {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }

            .btn-primary:hover {
                transform: scale(1.05);
                box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
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

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            .bot-status {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                padding: 20px;
                border-radius: 10px;
                text-align: center;
                margin-bottom: 20px;
            }

            .bot-status.disconnected {
                background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            }

            .grupos-list {
                max-height: 600px;
                overflow-y: auto;
                margin-top: 15px;
            }

            .grupo-item {
                background: #f3f4f6;
                padding: 20px;
                border-radius: 8px;
                margin-bottom: 15px;
                border-left: 4px solid #667eea;
                transition: all 0.3s ease;
            }

            .grupo-item:hover {
                background: #e5e7eb;
                transform: translateX(5px);
            }

            .grupo-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            }

            .grupo-id {
                font-weight: bold;
                color: #667eea;
                font-size: 1.1em;
                word-break: break-all;
            }

            .grupo-time {
                color: #9ca3af;
                font-size: 0.85em;
            }

            .grupo-info {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 10px;
                margin-top: 10px;
            }

            .info-badge {
                background: white;
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 0.9em;
            }

            .info-badge strong {
                color: #667eea;
                margin-right: 5px;
            }

            .loading {
                text-align: center;
                color: #6b7280;
                font-style: italic;
                padding: 20px;
            }

            .empty-state {
                text-align: center;
                padding: 40px;
                color: #6b7280;
            }

            .empty-state svg {
                width: 64px;
                height: 64px;
                margin-bottom: 15px;
                opacity: 0.5;
            }

            .alert {
                padding: 15px;
                border-radius: 8px;
                margin-bottom: 20px;
                display: none;
            }

            .alert-success {
                background: #d1fae5;
                color: #065f46;
                border: 1px solid #10b981;
            }

            .alert-error {
                background: #fee2e2;
                color: #991b1b;
                border: 1px solid #ef4444;
            }

            .alert.show {
                display: block;
            }

            .actions {
                display: flex;
                gap: 10px;
                justify-content: center;
                flex-wrap: wrap;
                margin-top: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>👥 Panel de Grupos</h1>
                <p>Gestiona y crea grupos de WhatsApp</p>
            </div>

            <div id="alertContainer"></div>

            <div class="dashboard">
                <!-- Card de Crear Grupo -->
                <div class="card">
                    <h2>➕ Crear Nuevo Grupo</h2>
                    
                    <div class="bot-status ${botConectado ? '' : 'disconnected'}" id="botStatus">
                        <span class="status-indicator ${botConectado ? 'status-connected' : 'status-disconnected'}"></span>
                        <strong>${botConectado ? 'Bot Conectado' : 'Bot Desconectado'}</strong>
                    </div>

                    <form id="crearGrupoForm">
                        <div class="form-group">
                            <label for="nombre">Nombre del Grupo</label>
                            <input 
                                type="text" 
                                id="nombre" 
                                name="nombre" 
                                placeholder="test grupos"
                                maxlength="25"
                            />
                            <small>Nombre del grupo (máximo 25 caracteres). Si está vacío, se usará "test grupos".</small>
                        </div>

                        <div class="form-group">
                            <label for="numeros">Números de Teléfono (máximo 10)</label>
                            <textarea 
                                id="numeros" 
                                name="numeros" 
                                placeholder="Ingresa los números, uno por línea&#10;Ejemplo:&#10;1234567890&#10;0987654321"
                                required
                            ></textarea>
                            <small>Separa cada número con un salto de línea. Máximo 10 números.</small>
                        </div>

                        <div class="form-group">
                            <label for="imagen">URL de Imagen (opcional)</label>
                            <input 
                                type="text" 
                                id="imagen" 
                                name="imagen" 
                                placeholder="https://ejemplo.com/imagen.jpg"
                            />
                            <small>URL de la imagen para el grupo (debe ser accesible públicamente) o base64.</small>
                        </div>

                        <button type="submit" class="btn btn-success" ${!botConectado ? 'disabled' : ''}>
                            ${botConectado ? '✨ Crear Grupo' : '⏳ Bot Desconectado'}
                        </button>
                    </form>

                    <div class="actions">
                        <a href="/qr" class="btn btn-primary">🔙 Volver al Dashboard</a>
                    </div>
                </div>

                <!-- Card de Lista de Grupos -->
                <div class="card">
                    <h2>📋 Grupos Creados</h2>
                    <div id="gruposList">
                        <div class="loading">Cargando grupos...</div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            function showAlert(message, type = 'success') {
                const alertContainer = document.getElementById('alertContainer');
                const alert = document.createElement('div');
                alert.className = \`alert alert-\${type} show\`;
                alert.textContent = message;
                alertContainer.appendChild(alert);

                setTimeout(() => {
                    alert.remove();
                }, 5000);
            }

            async function cargarGrupos() {
                try {
                    const response = await fetch('/api/grupos');
                    const data = await response.json();

                    const gruposList = document.getElementById('gruposList');

                    if (!data.success) {
                        gruposList.innerHTML = '<div class="empty-state">Error al cargar grupos</div>';
                        return;
                    }

                    if (data.grupos.length === 0) {
                        gruposList.innerHTML = \`
                            <div class="empty-state">
                                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
                                </svg>
                                <p>No hay grupos creados aún</p>
                                <p style="font-size: 0.9em; margin-top: 10px;">Crea tu primer grupo usando el formulario</p>
                            </div>
                        \`;
                        return;
                    }

                    const gruposHtml = data.grupos.map(grupo => {
                        const fecha = new Date(grupo.timestamp).toLocaleString('es-AR');
                        return \`
                            <div class="grupo-item">
                                <div class="grupo-header">
                                    <div class="grupo-id">📱 \${grupo.nombre || 'test grupos'}</div>
                                    <div class="grupo-time">🕐 \${fecha}</div>
                                </div>
                                <div style="color: #6b7280; font-size: 0.9em; margin-bottom: 10px; word-break: break-all;">
                                    ID: \${grupo.grupoId}
                                </div>
                                <div class="grupo-info">
                                    <div class="info-badge">
                                        <strong>Participantes:</strong> \${grupo.participantesAgregados}
                                    </div>
                                    <div class="info-badge">
                                        <strong>Estado:</strong> <span style="color: #10b981;">✅ \${grupo.status}</span>
                                    </div>
                                    <div class="info-badge">
                                        <strong>Imagen:</strong> \${grupo.imagenEstablecida ? '✅ Sí' : (grupo.tieneImagen ? '⚠️ Error' : '❌ No')}
                                    </div>
                                    \${grupo.errorImagen ? \`
                                        <div class="info-badge" style="grid-column: span 2; background: #fee2e2; color: #991b1b;">
                                            <strong>⚠️ Error imagen:</strong> \${grupo.errorImagen}
                                        </div>
                                    \` : ''}
                                    \${grupo.numerosInvalidos && grupo.numerosInvalidos.length > 0 ? \`
                                        <div class="info-badge" style="grid-column: span 2; background: #fee2e2; color: #991b1b;">
                                            <strong>⚠️ Números inválidos:</strong> \${grupo.numerosInvalidos.join(', ')}
                                        </div>
                                    \` : ''}
                                </div>
                            </div>
                        \`;
                    }).join('');

                    gruposList.innerHTML = \`
                        <div class="grupos-list">\${gruposHtml}</div>
                        <p style="text-align: center; color: #6b7280; margin-top: 15px; font-size: 0.9em;">
                            Mostrando \${data.grupos.length} de \${data.total} grupos
                        </p>
                    \`;
                } catch (error) {
                    document.getElementById('gruposList').innerHTML = \`
                        <div class="empty-state" style="color: #ef4444;">
                            ❌ Error al cargar grupos: \${error.message}
                        </div>
                    \`;
                }
            }

            document.getElementById('crearGrupoForm').addEventListener('submit', async (e) => {
                e.preventDefault();

                const nombre = document.getElementById('nombre').value.trim();
                const numerosText = document.getElementById('numeros').value.trim();
                const imagen = document.getElementById('imagen').value.trim();

                if (!numerosText) {
                    showAlert('Por favor ingresa al menos un número', 'error');
                    return;
                }

                const numeros = numerosText
                    .split('\\n')
                    .map(num => num.trim())
                    .filter(num => num.length > 0);

                if (numeros.length === 0) {
                    showAlert('Por favor ingresa al menos un número válido', 'error');
                    return;
                }

                if (numeros.length > 10) {
                    showAlert('Máximo 10 números permitidos', 'error');
                    return;
                }

                const submitBtn = e.target.querySelector('button[type="submit"]');
                submitBtn.disabled = true;
                submitBtn.textContent = '⏳ Creando grupo...';

                try {
                    const response = await fetch('/crear-grupo', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            nombre: nombre || undefined,
                            numeros: numeros,
                            imagen: imagen || undefined
                        })
                    });

                    const data = await response.json();

                    if (data.success) {
                        showAlert(\`✅ Grupo creado exitosamente! ID: \${data.grupoId}\`, 'success');
                        document.getElementById('crearGrupoForm').reset();
                        cargarGrupos();
                    } else {
                        showAlert(\`❌ Error: \${data.error}\`, 'error');
                    }
                } catch (error) {
                    showAlert(\`❌ Error al crear grupo: \${error.message}\`, 'error');
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '✨ Crear Grupo';
                }
            });

            cargarGrupos();
            setInterval(cargarGrupos, 5000);
        </script>
    </body>
    </html>
    `;

    res.send(html);
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
                max-width: 1400px;
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
                grid-template-columns: 400px 1fr;
                gap: 20px;
                margin-bottom: 20px;
            }

            @media (max-width: 1200px) {
                .dashboard {
                    grid-template-columns: 1fr;
                }
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
                max-height: 600px;
                overflow-y: auto;
                margin-top: 15px;
            }

            .message-item {
                background: #f3f4f6;
                padding: 15px;
                border-radius: 8px;
                margin-bottom: 10px;
                border-left: 4px solid #667eea;
                transition: all 0.3s ease;
            }

            .message-item:hover {
                background: #e5e7eb;
                transform: translateX(5px);
            }

            .message-item.error {
                border-left-color: #ef4444;
                background: #fee2e2;
            }

            .message-item.enviado {
                border-left-color: #10b981;
            }

            .message-item.entregado {
                border-left-color: #059669;
            }

            .message-item.leido {
                border-left-color: #047857;
                background: #d1fae5;
            }

            .message-item.enviando {
                border-left-color: #f59e0b;
                background: #fef3c7;
            }

            .message-item.en_cola {
                border-left-color: #6b7280;
            }

            .message-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 10px;
            }

            .message-number {
                font-weight: bold;
                color: #667eea;
                font-size: 1.1em;
            }

            .message-status-badge {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 5px 12px;
                border-radius: 20px;
                font-size: 0.85em;
                font-weight: bold;
                background: white;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }

            .status-en_cola {
                background: #e5e7eb;
                color: #374151;
            }

            .status-enviando {
                background: #fef3c7;
                color: #92400e;
            }

            .status-enviado {
                background: #d1fae5;
                color: #065f46;
            }

            .status-entregado {
                background: #a7f3d0;
                color: #047857;
            }

            .status-leido {
                background: #6ee7b7;
                color: #064e3b;
            }

            .status-error {
                background: #fee2e2;
                color: #991b1b;
            }

            .status-reintentando {
                background: #fed7aa;
                color: #9a3412;
            }

            .message-text {
                color: #4b5563;
                margin: 8px 0;
                font-size: 0.95em;
                line-height: 1.4;
            }

            .message-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid rgba(0,0,0,0.1);
            }

            .message-time {
                color: #9ca3af;
                font-size: 0.8em;
            }

            .message-id {
                color: #9ca3af;
                font-size: 0.75em;
                font-family: monospace;
            }

            .message-error {
                color: #ef4444;
                font-size: 0.85em;
                margin-top: 8px;
                padding: 8px;
                background: white;
                border-radius: 5px;
            }

            .info-item {
                display: flex;
                justify-content: space-between;
                padding: 12px 0;
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
                padding: 20px;
            }

            .actions {
                display: flex;
                gap: 10px;
                justify-content: center;
                flex-wrap: wrap;
                margin-top: 20px;
            }

            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 15px;
                margin-bottom: 20px;
            }

            .stat-card {
                background: linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%);
                padding: 20px;
                border-radius: 10px;
                text-align: center;
                transition: transform 0.3s ease;
            }

            .stat-card:hover {
                transform: scale(1.05);
            }

            .stat-number {
                font-size: 2em;
                font-weight: bold;
                color: #667eea;
                margin-bottom: 5px;
            }

            .stat-label {
                color: #6b7280;
                font-size: 0.9em;
            }

            .filter-buttons {
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
                margin-bottom: 15px;
            }

            .filter-btn {
                padding: 8px 16px;
                border: 2px solid #e5e7eb;
                background: white;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.3s ease;
                font-size: 0.9em;
                font-weight: 500;
            }

            .filter-btn:hover {
                border-color: #667eea;
                color: #667eea;
            }

            .filter-btn.active {
                background: #667eea;
                color: white;
                border-color: #667eea;
            }

            @media (max-width: 768px) {
                .header h1 {
                    font-size: 1.8em;
                }
                
                .stats-grid {
                    grid-template-columns: repeat(2, 1fr);
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🤖 WhatsApp Bot Dashboard</h1>
                <p>Panel de control y monitoreo avanzado</p>
            </div>

            <div class="dashboard">
                <!-- Sidebar: Conexión y Sistema -->
                <div>
                    <!-- Card de Conexión -->
                    <div class="card" style="margin-bottom: 20px;">
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
                </div>

                <!-- Main: Mensajes -->
                <div class="card">
                    <h2>📨 Historial de Mensajes</h2>
                    
                    <!-- Estadísticas -->
                    <div class="stats-grid" id="statsGrid">
                        <div class="stat-card">
                            <div class="stat-number" id="statTotal">0</div>
                            <div class="stat-label">Total</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="statEnviados">0</div>
                            <div class="stat-label">✅ Enviados</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="statEntregados">0</div>
                            <div class="stat-label">✅✅ Entregados</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="statLeidos">0</div>
                            <div class="stat-label">✅✅✅ Leídos</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="statCola">0</div>
                            <div class="stat-label">⏳ En Cola</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="statErrores">0</div>
                            <div class="stat-label">❌ Errores</div>
                        </div>
                    </div>

                    <!-- Filtros -->
                    <div class="filter-buttons">
                        <button class="filter-btn active" onclick="filtrarMensajes('todos')">Todos</button>
                        <button class="filter-btn" onclick="filtrarMensajes('en_cola')">⏳ En Cola</button>
                        <button class="filter-btn" onclick="filtrarMensajes('enviando')">📤 Enviando</button>
                        <button class="filter-btn" onclick="filtrarMensajes('enviado')">✅ Enviados</button>
                        <button class="filter-btn" onclick="filtrarMensajes('entregado')">✅✅ Entregados</button>
                        <button class="filter-btn" onclick="filtrarMensajes('leido')">✅✅✅ Leídos</button>
                        <button class="filter-btn" onclick="filtrarMensajes('error')">❌ Errores</button>
                    </div>

                    <!-- Lista de mensajes -->
                    <div id="messagesList">
                        <div class="loading">Cargando mensajes...</div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let filtroActual = 'todos';

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
                        actualizarEstadisticas([]);
                        return;
                    }

                    // Actualizar estadísticas
                    actualizarEstadisticas(data.mensajes);

                    // Filtrar mensajes
                    const mensajesFiltrados = filtroActual === 'todos' 
                        ? data.mensajes 
                        : data.mensajes.filter(msg => msg.status === filtroActual);

                    if (mensajesFiltrados.length === 0) {
                        document.getElementById('messagesList').innerHTML = '<div class="loading">No hay mensajes con este filtro</div>';
                        return;
                    }

                    const messagesHtml = mensajesFiltrados.slice(0, 50).map(msg => \`
                        <div class="message-item \${msg.status}">
                            <div class="message-header">
                                <div class="message-number">📱 \${msg.numero}</div>
                                <span class="message-status-badge status-\${msg.status}">
                                    \${msg.statusIcon} \${msg.statusText}
                                </span>
                            </div>
                            <div class="message-text">\${msg.texto}</div>
                            <div class="message-footer">
                                <div class="message-time">🕐 \${new Date(msg.timestamp).toLocaleString('es-AR')}</div>
                                \${msg.messageId ? \`<div class="message-id">ID: \${msg.messageId.substring(0, 15)}...</div>\` : ''}
                            </div>
                            \${msg.error ? \`<div class="message-error">⚠️ \${msg.error}</div>\` : ''}
                            \${msg.lastUpdate && msg.lastUpdate !== msg.timestamp ? \`
                                <div style="color: #6b7280; font-size: 0.75em; margin-top: 5px;">
                                    Última actualización: \${new Date(msg.lastUpdate).toLocaleString('es-AR')}
                                </div>
                            \` : ''}
                        </div>
                    \`).join('');

                    document.getElementById('messagesList').innerHTML = \`
                        <div class="messages-list">\${messagesHtml}</div>
                        <p style="text-align: center; color: #6b7280; margin-top: 15px; font-size: 0.9em;">
                            Mostrando \${Math.min(50, mensajesFiltrados.length)} de \${mensajesFiltrados.length} mensajes filtrados (\${data.total} total)
                        </p>
                    \`;
                } catch (error) {
                    document.getElementById('messagesList').innerHTML = '<div class="loading" style="color: #ef4444;">Error al cargar mensajes</div>';
                }
            }

            function actualizarEstadisticas(mensajes) {
                const stats = {
                    total: mensajes.length,
                    enviado: mensajes.filter(m => m.status === 'enviado').length,
                    entregado: mensajes.filter(m => m.status === 'entregado').length,
                    leido: mensajes.filter(m => m.status === 'leido').length,
                    en_cola: mensajes.filter(m => m.status === 'en_cola' || m.status === 'enviando').length,
                    error: mensajes.filter(m => m.status === 'error').length
                };

                document.getElementById('statTotal').textContent = stats.total;
                document.getElementById('statEnviados').textContent = stats.enviado;
                document.getElementById('statEntregados').textContent = stats.entregado;
                document.getElementById('statLeidos').textContent = stats.leido;
                document.getElementById('statCola').textContent = stats.en_cola;
                document.getElementById('statErrores').textContent = stats.error;
            }

            function filtrarMensajes(filtro) {
                filtroActual = filtro;
                
                // Actualizar botones activos
                document.querySelectorAll('.filter-btn').forEach(btn => {
                    btn.classList.remove('active');
                });
                event.target.classList.add('active');
                
                cargarMensajes();
            }

            // Cargar datos iniciales
            cargarEstadoSistema();
            cargarMensajes();

            // Actualizar cada 3 segundos
            setInterval(() => {
                cargarEstadoSistema();
                cargarMensajes();
            }, 3000);
        </script>
    </body>
    </html>
    `;

    res.send(html);
});