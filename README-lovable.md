# Backend multicuenta WhatsApp (Baileys) — Guía rápida para Lovable

## Variables de entorno
```
PORT=3000
API_KEY=clave_privada_que_enviará_lovable
LOVABLE_ORIGIN=https://tu-app.lovable.dev   # o * para desarrollo
```

## Estructura de sesiones
- Directorio persistente: `/sessions/{sessionId}/`
- Dentro se guardan los archivos de autenticación de Baileys y `logs.txt`.
- En Render, monta un Persistent Disk apuntando a `/sessions`.

## Endpoints (todas requieren header `x-api-key`)

### 1) Obtener QR
`GET /session/qr?sessionId=SESSION_ID`
```json
{
  "success": true,
  "qr": "data:image/png;base64,...",   // null si ya está conectado
  "status": "waiting_for_scan|connected",
  "phone": "+54911..."                 // sólo si está conectado
}
```

### 2) Estado de la sesión
`GET /session/status?sessionId=SESSION_ID`
```json
{
  "success": true,
  "status": "connected|waiting_for_scan|disconnected|initializing",
  "phone": "+54911...",
  "lastSync": "2025-01-10T21:00:00Z"
}
```

### 3) Enviar mensaje
`POST /sendMessage`
```json
{
  "sessionId": "SESSION_ID",
  "to": "+54911xxxxxxx",
  "message": "hola"
}
```
Respuesta:
```json
{ "success": true, "status": "sent" }
```

### 4) Webhook externo (para integrarlo con otros sistemas)
`POST /webhook/:sessionId`
```json
{
  "to": "+54911xxxxxxx",
  "message": "hola"
}
```

### 5) Stats
`GET /stats?sessionId=SESSION_ID`
```json
{
  "success": true,
  "messagesSent": 32,
  "planLimit": 1000,
  "remaining": 968
}
```

### 6) Healthcheck
`GET /health`
```json
{ "status": "ok", "timestamp": "..." }
```

## Cómo conectarlo desde Lovable (resumen)
1) Genera un `sessionId` único en el front (ej: `session_abc123`).
2) Llama a `GET /session/qr?sessionId=session_abc123` y muestra el `qr` (data URL).
3) Refresca el estado cada 3-5s con `GET /session/status?sessionId=session_abc123`.
4) Cuando `status === "connected"`, habilita el botón “Enviar mensaje de prueba”.
5) Para enviar: `POST /sendMessage` con ese `sessionId`.
6) Guarda `sessionId` asociado al usuario en tu base de datos del front.

## Seguridad
- Todas las rutas usan `x-api-key`.
- Configura `LOVABLE_ORIGIN` para restringir CORS en producción.

## Notas de despliegue en Render
- Monta un Persistent Disk en `/sessions`.
- Mantén `PORT` según Render (`$PORT`).
- Proc type: web, start command: `npm start`.


