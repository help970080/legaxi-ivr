// ============================================================
// LeGaXi IVR v5.0 - ZADARMA API
// Llamadas automáticas con IVR de centralita
// Deploy: Render.com (Docker)
// ============================================================
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- CONFIG ----
const {
  ZADARMA_API_KEY = '',
  ZADARMA_API_SECRET = '',
  ZADARMA_SIP = '681294',
  ZADARMA_CALLER_ID = '+525598160911',
  WHATSAPP_NUMBER = '5544621100',
  GAS_WEBHOOK_URL,
  SERVER_URL = 'https://legaxi-ivr.onrender.com',
  API_KEY,
  PORT = 3000
} = process.env;

// ---- CORS ----
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  if (!API_KEY) return next();
  const k = req.headers['x-api-key'] || req.query.api_key;
  if (k !== API_KEY) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ---- ZADARMA API (using official library) ----
const { api: z_api } = require('zadarma');

function zadarmaRequest(method, params = {}) {
  return z_api({
    api_method: method,
    api_user_key: ZADARMA_API_KEY,
    api_secret_key: ZADARMA_API_SECRET,
    params: Object.keys(params).length > 0 ? params : undefined
  });
}

// ---- CAMPAIGNS & CALLS ----
const campaigns = new Map();
const activeCalls = new Map();

// ============================================================
// HACER LLAMADA - callback predicted (deudor escucha IVR)
// ============================================================
async function makeCall(phone, campaignId, index, clientData) {
  let cleanPhone = (phone || '').replace(/\D/g, '');
  // Quitar prefijo 52 - la centralita lo agrega
  if (cleanPhone.startsWith('52') && cleanPhone.length === 12) cleanPhone = cleanPhone.substring(2);
  if (cleanPhone.startsWith('+52')) cleanPhone = cleanPhone.substring(3);
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);

  const params = {
    from: ZADARMA_SIP,
    predicted: 'predicted',
    sip: ZADARMA_SIP,
    to: cleanPhone
  };

  console.log(`📞 [${campaignId}] #${index} Llamando ${clientData.nombre} → ${cleanPhone}`);
  const result = await zadarmaRequest('/v1/request/callback/', params);

  if (result.status === 'success') {
    activeCalls.set(`${campaignId}-${index}`, {
      campaignId, index, phone: cleanPhone,
      nombre: clientData.nombre, startTime: Date.now(),
      ...clientData
    });
    console.log(`   ✅ Llamada enviada`);
  } else {
    console.log(`   ❌ Error: ${JSON.stringify(result)}`);
    logResult(campaignId, index, null, 'error_api');
  }
  return result;
}

// ============================================================
// ZADARMA WEBHOOKS
// ============================================================
app.post('/zadarma', (req, res) => {
  const event = req.body.event;
  console.log(`📨 Webhook: ${event}`, JSON.stringify(req.body).substring(0, 500));

  if (event === 'NOTIFY_OUT_START') {
    const dest = req.body.destination;
    console.log(`   📱 Deudor contestó: ${dest}`);
  }

  if (event === 'NOTIFY_OUT_END') {
    const dest = req.body.destination;
    const duration = parseInt(req.body.duration) || 0;
    const disposition = req.body.disposition;
    console.log(`   📴 Fin: ${dest} ${duration}s ${disposition}`);

    for (const [key, call] of activeCalls) {
      if (dest && (dest.includes(call.phone) || call.phone.includes(dest))) {
        if (!call.logged) {
          const resultado = disposition === 'answered' && duration > 5 ? 'contactado' : 'no_contesto';
          logResult(call.campaignId, call.index, null, resultado);
        }
        activeCalls.delete(key);
        break;
      }
    }
  }

  if (event === 'NOTIFY_IVR') {
    const dtmf = req.body.dtmf;
    const dest = req.body.called_did || req.body.caller_id || req.body.destination;
    console.log(`   🔢 IVR DTMF=${dtmf} de ${dest}`);

    let resultado = 'sin_respuesta';
    if (dtmf === '1') resultado = 'pago';
    else if (dtmf === '2') resultado = 'promesa_pago';
    else if (dtmf === '3') resultado = 'asesor';

    for (const [key, call] of activeCalls) {
      if (dest && (dest.includes(call.phone) || call.phone.includes(dest))) {
        logResult(call.campaignId, call.index, resultado, null);
        break;
      }
    }
  }

  res.json({});
});

app.get('/zadarma', (req, res) => {
  if (req.query.zd_echo) return res.send(req.query.zd_echo);
  res.json({ status: 'ok', webhook: 'zadarma' });
});

// ============================================================
// LOG RESULTADO → GAS
// ============================================================
function logResult(campaignId, index, menuValue, callStatus) {
  const camp = campaigns.get(campaignId);
  if (!camp || index === undefined) return;
  const cl = camp.clients[index];
  if (!cl || cl.logged) return;

  const resultado = menuValue || callStatus || 'sin_respuesta';
  cl.resultado = resultado;
  cl.logged = true;
  camp.completed = (camp.completed || 0) + 1;
  console.log(`📊 [${campaignId}] #${index} ${cl.nombre}: ${resultado}`);

  if (GAS_WEBHOOK_URL) {
    const payload = JSON.stringify({
      action: 'registrarLlamadaIVR',
      nombre: cl.nombre, telefono: cl.telefono,
      saldo: cl.saldo || '', diasAtraso: cl.diasAtraso || '',
      promotor: cl.promotor || '', resultado,
      detalle: menuValue ? `IVR: ${menuValue}` : (callStatus || 'Sin respuesta'),
      cobrador: cl.cobrador || '', campaignId
    });
    const url = new URL(GAS_WEBHOOK_URL);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', e => console.error('GAS error:', e.message));
    req.write(payload); req.end();
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================
app.post('/api/campaign', auth, async (req, res) => {
  try {
    const { clients, delaySeconds = 25 } = req.body;
    if (!clients?.length) return res.status(400).json({ error: 'No hay clientes' });

    const campaignId = crypto.randomUUID().slice(0, 8);
    const cls = clients.map(c => ({ ...c, resultado: 'pendiente', logged: false }));
    campaigns.set(campaignId, {
      clients: cls, started: new Date().toISOString(),
      completed: 0, total: cls.length, cancelled: false
    });

    res.json({ campaignId, total: cls.length, status: 'iniciada' });

    for (let i = 0; i < cls.length; i++) {
      const camp = campaigns.get(campaignId);
      if (!camp || camp.cancelled) break;
      try {
        await makeCall(cls[i].telefono, campaignId, i, cls[i]);
      } catch (err) {
        console.error(`❌ Error llamada ${i}:`, err.message);
        logResult(campaignId, i, null, 'error');
      }
      if (i < cls.length - 1) await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }
    console.log(`✅ Campaña ${campaignId} completada`);
  } catch (err) {
    console.error('Campaign error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaign/:id', auth, (req, res) => {
  const camp = campaigns.get(req.params.id);
  if (!camp) return res.status(404).json({ error: 'No encontrada' });
  res.json({
    campaignId: req.params.id, total: camp.total,
    completed: camp.completed || 0, cancelled: !!camp.cancelled,
    clients: camp.clients.map(c => ({
      nombre: c.nombre, telefono: c.telefono,
      saldo: c.saldo || '', resultado: c.resultado || 'pendiente'
    }))
  });
});

app.post('/api/campaign/:id/cancel', auth, (req, res) => {
  const camp = campaigns.get(req.params.id);
  if (!camp) return res.status(404).json({ error: 'No encontrada' });
  camp.cancelled = true;
  res.json({ status: 'cancelada' });
});

app.post('/api/test-call', auth, async (req, res) => {
  try {
    const { phone, nombre = 'Prueba' } = req.body;
    const result = await makeCall(phone, 'test', 0, { nombre, telefono: phone });
    res.json({ success: result.status === 'success', result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/balance', auth, async (req, res) => {
  try { res.json(await zadarmaRequest('/v1/info/balance/')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/config', auth, (req, res) => {
  res.json({
    provider: 'zadarma',
    zadarma: { configured: !!(ZADARMA_API_KEY && ZADARMA_API_SECRET), sip: ZADARMA_SIP, callerId: ZADARMA_CALLER_ID },
    gas: { configured: !!GAS_WEBHOOK_URL },
    whatsapp: WHATSAPP_NUMBER, serverUrl: SERVER_URL,
    activeCalls: activeCalls.size, activeCampaigns: campaigns.size
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', provider: 'zadarma', uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.json({ service: 'LeGaXi IVR v5.0 - Zadarma', status: 'running' }));

const panelPath = path.join(__dirname, 'panel.html');
if (fs.existsSync(panelPath)) app.get('/panel', (req, res) => res.sendFile(panelPath));

app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   🚀 LeGaXi IVR v5.0 - ZADARMA              ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║ Puerto: ${PORT}`);
  console.log(`║ SIP: ${ZADARMA_SIP} | CallerID: ${ZADARMA_CALLER_ID}`);
  console.log(`║ WhatsApp: ${WHATSAPP_NUMBER}`);
  console.log(`║ Webhook: ${SERVER_URL}/zadarma`);
  console.log(`║ GAS: ${GAS_WEBHOOK_URL ? '✅' : '❌'}`);
  console.log('╚═══════════════════════════════════════════════╝');
});
