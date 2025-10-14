# Bot WhatsApp con Sistema de Cola

## 🚀 Características Implementadas

### ✅ Sistema de Cola de Mensajes
- **Sin pisado**: Los mensajes se procesan uno a la vez en orden
- **Sin memoria**: Los mensajes se envían directamente, no se almacenan
- **Procesamiento secuencial**: Garantiza que no se pierdan mensajes

### ✅ Sistema de Reintentos Automáticos
- **4 intentos máximo** por mensaje
- **10 segundos de espera** entre reintentos
- **Logging detallado** de cada intento

### ✅ Endpoints Disponibles

#### `POST /enviar-mensaje`
Envía un mensaje a través de la cola.

**Body:**
```json
{
  "numero": "1234567890",
  "texto": "Tu mensaje aquí"
}
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "Mensaje enviado a 1234567890",
  "queueId": 1703123456789.123,
  "attempts": 1
}
```

#### `GET /estado-cola`
Verifica el estado actual de la cola.

**Respuesta:**
```json
{
  "cola": {
    "queueLength": 2,
    "processing": true
  },
  "botConectado": true
}
```

#### `GET /qr`
Muestra el código QR para conectar WhatsApp.

## 🧪 Cómo Probar el Sistema

### 1. Instalar dependencias
```bash
npm install
```

### 2. Iniciar el bot
```bash
npm start
```

### 3. Escanear QR
- Ve a `http://localhost:3000/qr`
- Escanea el código QR con WhatsApp

### 4. Probar la cola
```bash
# Instalar axios para las pruebas
npm install axios

# Ejecutar pruebas
npm run test-queue
```

## 📊 Logs del Sistema

El sistema genera logs detallados:

```
[COLA] Mensaje agregado a la cola. Total en cola: 3
[COLA] Procesando cola. Mensajes pendientes: 3
[COLA] Procesando mensaje 1703123456789.123 (intento 1/4)
[COLA] Mensaje 1703123456789.123 enviado exitosamente a 1234567890
[COLA] Reintentando mensaje 1703123456790.456 en 10 segundos...
[COLA] Cola procesada completamente
```

## 🔧 Configuración

### Variables de Entorno
- `PORT`: Puerto del servidor (default: 3000)
- `RENDER`: Si es 'true', usa directorio `/data/session` para Render

### Parámetros de la Cola
- **Máximo intentos**: 4
- **Tiempo entre reintentos**: 10 segundos
- **Procesamiento**: Secuencial (uno a la vez)

## 🚨 Manejo de Errores

### Errores Comunes
1. **Bot no conectado**: El mensaje se reintentará automáticamente
2. **Número no existe**: Se reintentará 4 veces, luego falla
3. **Error de red**: Se reintentará con espera de 10 segundos

### Respuesta de Error
```json
{
  "error": "Error al enviar el mensaje después de múltiples intentos",
  "details": "El número no existe en WhatsApp",
  "queueId": 1703123456789.123,
  "attempts": 4
}
```

## 📈 Ventajas del Sistema

1. **Confiabilidad**: Los mensajes no se pierden
2. **Eficiencia**: No consume memoria innecesaria
3. **Trazabilidad**: Cada mensaje tiene un ID único
4. **Resiliencia**: Reintentos automáticos ante fallos
5. **Monitoreo**: Endpoint para verificar estado de la cola

## 🔄 Flujo de Procesamiento

1. **Recepción**: Mensaje llega al endpoint `/enviar-mensaje`
2. **Cola**: Se agrega a la cola de procesamiento
3. **Procesamiento**: Se procesa uno a la vez
4. **Envío**: Intento de envío directo a WhatsApp
5. **Reintento**: Si falla, se reintenta en 10 segundos
6. **Finalización**: Éxito o fallo después de 4 intentos
