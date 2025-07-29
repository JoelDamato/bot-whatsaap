// index.js
const { default: makeWASocket, useSingleFileAuthState } = require('@whiskeysockets/baileys')
const path = require('path')
const fs = require('fs')

// Ruta del archivo de sesión (Render lo guardará en /data)
const authFilePath = path.join('/data', 'auth.json')
const { state, saveState } = useSingleFileAuthState(authFilePath)

async function startBot() {
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    })

    sock.ev.on('creds.update', saveState)

    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') {
            console.log('✅ Conectado a WhatsApp')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.key.fromMe) {
            await sock.sendMessage(msg.key.remoteJid, { text: 'Hola! Soy tu bot 🤖' })
        }
    })
}

startBot()
