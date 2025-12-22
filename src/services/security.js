const API_KEY = process.env.API_KEY || '';

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY) {
    console.warn('[SECURITY] API_KEY no configurada, se permite el acceso (solo para desarrollo)');
    return next();
  }

  if (key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'API key inválida' });
  }

  return next();
}

module.exports = { requireApiKey };


