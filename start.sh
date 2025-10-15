#!/bin/bash

echo "🚀 Iniciando Bot de WhatsApp en Render..."
echo "================================================"

# --- Variables de entorno ---
export RENDER=true
export PORT=10000
export NODE_OPTIONS="--max-old-space-size=512 --expose-gc"

# --- Información del sistema ---
echo "📊 Información del sistema:"
echo "   - Node version: $(node --version)"
echo "   - NPM version: $(npm --version)"
echo "   - Puerto: $PORT"
echo "   - Memoria: 512MB"
echo "================================================"

# --- Verificar directorio de sesión ---
if [ ! -d "/data" ]; then
    echo "⚠️  ADVERTENCIA: El directorio /data no existe"
    echo "   Asegúrate de haber configurado un disco persistente en Render"
else
    echo "✅ Disco persistente detectado en /data"
    
    # Crear directorio de sesión si no existe
    if [ ! -d "/data/session" ]; then
        mkdir -p /data/session
        echo "📁 Directorio de sesión creado: /data/session"
    else
        echo "📁 Directorio de sesión existe: /data/session"
    fi
    
    # Mostrar archivos de sesión (si existen)
    SESSION_FILES=$(ls -A /data/session 2>/dev/null | wc -l)
    if [ $SESSION_FILES -gt 0 ]; then
        echo "📱 Sesión encontrada ($SESSION_FILES archivos)"
        echo "   El bot intentará reconectar automáticamente"
    else
        echo "📱 Sin sesión previa"
        echo "   Se generará un nuevo código QR"
    fi
fi

echo "================================================"
echo "🔄 Iniciando servidor Node.js..."
echo "================================================"

# --- Iniciar bot con reinicio automático en caso de crash ---
while true; do
    node index.js
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ]; then
        echo "✅ Bot finalizado correctamente"
        break
    else
        echo "❌ Bot se detuvo con código: $EXIT_CODE"
        echo "🔄 Reiniciando en 5 segundos..."
        sleep 5
    fi
done