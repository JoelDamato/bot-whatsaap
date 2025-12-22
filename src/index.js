// Backend multicuenta para WhatsApp Web (Baileys)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const sessionRoutes = require('./routes/sessionRoutes');

const app = express();

// --- Configuración básica ---
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.LOVABLE_ORIGIN || '*';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// --- Rutas ---
app.use('/', sessionRoutes);

// --- Healthcheck ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Error handler genérico ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Error interno',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 API WhatsApp multicuenta escuchando en puerto ${PORT}`);
});


