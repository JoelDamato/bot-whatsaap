const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../services/security');
const sessionService = require('../services/sessionService');

// Middleware de API key para todas las rutas
router.use(requireApiKey);

// Obtener QR de una sesión
router.get('/session/qr', async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId es requerido' });
    }

    const data = await sessionService.getQR(sessionId);
    res.json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
});

// Estado de la sesión
router.get('/session/status', async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId es requerido' });
    }

    const status = await sessionService.getStatus(sessionId);
    res.json({ success: true, ...status });
  } catch (err) {
    next(err);
  }
});

// Enviar mensaje
router.post('/sendMessage', async (req, res, next) => {
  try {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
      return res.status(400).json({ success: false, error: 'sessionId, to y message son requeridos' });
    }

    const result = await sessionService.sendMessage(sessionId, to, message);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Webhook externo para enviar mensajes
router.post('/webhook/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ success: false, error: 'to y message son requeridos' });
    }

    const result = await sessionService.sendMessage(sessionId, to, message);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Estadísticas de la sesión
router.get('/stats', async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId es requerido' });
    }

    const stats = await sessionService.getStats(sessionId);
    res.json({ success: true, ...stats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;


