// ============================================================
// LeGaXi IVR v4.0 - SINCH Voice API
// Llamadas automáticas con IVR (Presione 1, 2, 3)
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
  SINCH_APP_KEY = '5981949f-a13f-45c5-aa5d-be5e7dbcc063',
  SINCH_APP_SECRET = 'tJaOJlbUlU6DEZFpUQ3DgQ==',
  SINCH_FROM_NUMBER = '+447418631394',
  SINCH_API_URL = 'https://calling.api.sinch.com/calling/v1',
  GAS_WEBHOOK_URL,
  SERVER_URL = 'https://legaxi-ivr.onrender.com',
  API_KEY,
  DEFAULT_COBRADOR_PHONE = '+525544621100',
  PORT = 3000
} = process.env;

const AUTH = 'Basic ' + Buffer.from(`${SINCH_APP_KEY}:${SINCH_APP_SECRET}`).toString('base64');

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

// ---- CAMPAIGNS ----
const campaigns = new Map();
const callData = new Map(); // callId → { campaignId, index, clientData }

// ============================================================
// SINCH: Hacer llamada con CustomCallout (IVR completo)
// ============================================================
async function sinchCallWithIVR(phone, texto, campaignId, index, clientData) {
  const callbackUrl = `${SERVER_URL}/sinch`;

  // CustomCallout con ICE (conectar), ACE (menú IVR), PIE/DICE (resultados)
  const body = JSON.stringify({
    method: 'customCallout',
    customCallout: {
      // ICE: Incoming Call Event - conectar la llamada
      ice: JSON.stringify({
        action: {
          name: 'connectPstn',
          number: phone,
          cli: SINCH_FROM_NUMBER.replace('+', ''),
          locale: 'es-MX'
        }
      }),
      // ACE: Answered Call Event - reproducir menú IVR
      ace: JSON.stringify({
        action: {
          name: 'runMenu',
          locale: 'es-MX',
          menus: [{
            id: 'main',
            mainPrompt: `#tts[${texto}]`,
            timeoutMills: 10000,
            options: [
              { dtmf: '1', action: 'return(promesa_pago)' },
              { dtmf: '2', action: 'return(transferencia)' },
              { dtmf: '3', action: 'return(ya_pago)' }
            ]
          }]
        }
      }),
      // PIE: Prompt Input Event - resultado del menú
      pie: callbackUrl,
      // DICE: Disconnect Call Event
      dice: callbackUrl
    }
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${SINCH_API_URL}/callouts`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Guardar datos de la llamada para cuando llegue el callback
          if (parsed.callId) {
            callData.set(parsed.callId, { campaignId, index, ...clientData });
          }
          console.log(`📞 Sinch call → ${phone}: callId=${parsed.callId || 'ERROR'} | FULL RESPONSE: ${JSON.stringify(parsed)}`);
          resolve(parsed);
        } catch (e) {
          console.error('Sinch response parse error:', data);
          resolve({ error: data });
        }
      });
    });
    req.on('error', (e) => { console.error('Sinch request error:', e.message); reject(e); });
    console.log(`📤 Sinch CustomCallout REQUEST to ${phone}: ${body.substring(0, 300)}...`);
    req.write(body);
    req.end();
  });
}

// ============================================================
// SINCH: Llamada simple TTS (sin IVR, solo mensaje)
// ============================================================
async function sinchCallTTS(phone, texto) {
  const body = JSON.stringify({
    method: 'ttsCallout',
    ttsCallout: {
      cli: SINCH_FROM_NUMBER.replace('+', ''),
      destination: { type: 'number', endpoint: phone },
      domain: 'pstn',
      locale: 'es-MX',
      text: texto
    }
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${SINCH_API_URL}/callouts`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`📞 Sinch TTS → ${phone}: HTTP ${res.statusCode} | RESPONSE: ${data}`);
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', (e) => { console.error('Sinch TTS error:', e.message); reject(e); });
    console.log(`📤 Sinch TTS REQUEST: ${body}`);
    req.write(body);
    req.end();
  });
}

// ============================================================
// SINCH CALLBACKS - PIE (resultado menú) y DICE (desconexión)
// ============================================================
app.post('/sinch', (req, res) => {
  const event = req.body.event;
  const callId = req.body.callid || req.body.callId;

  console.log(`📨 Sinch callback: ${event} callId=${callId}`);

  if (event === 'pie') {
    // Prompt Input Event - el deudor presionó algo
    const menuResult = req.body.menuResult;
    const value = menuResult?.value || 'sin_respuesta';
    const cd = callData.get(callId);

    console.log(`   → Resultado: ${value} (método: ${menuResult?.inputMethod})`);

    if (cd) {
      logResult(cd.campaignId, cd.index, value);
    }

    // Responder con SVAML según la opción
    const nombre = (cd?.nombre || 'Cliente').split(' ')[0];
    const cobPhone = cd?.telefonoCobrador || DEFAULT_COBRADOR_PHONE;
    let svaml;

    if (value === 'promesa_pago') {
      svaml = {
        instructions: [{ name: 'say', text: `Gracias ${nombre}. Registramos su promesa de pago. Un asesor le contactará pronto. Hasta luego.`, locale: 'es-MX' }],
        action: { name: 'hangup' }
      };
    } else if (value === 'transferencia') {
      svaml = {
        instructions: [{ name: 'say', text: 'Conectándole con su asesor.', locale: 'es-MX' }],
        action: { name: 'connectPstn', number: cobPhone.replace('+', ''), cli: SINCH_FROM_NUMBER.replace('+', '') }
      };
    } else if (value === 'ya_pago') {
      svaml = {
        instructions: [{ name: 'say', text: `Gracias ${nombre}. Registramos su pago. Lo verificaremos. Buen día.`, locale: 'es-MX' }],
        action: { name: 'hangup' }
      };
    } else {
      svaml = {
        instructions: [{ name: 'say', text: 'No recibimos respuesta. Le contactaremos pronto. Hasta luego.', locale: 'es-MX' }],
        action: { name: 'hangup' }
      };
    }

    return res.json(svaml);
  }

  if (event === 'dice') {
    // Disconnect - llamada terminó
    const reason = req.body.reason;
    const cd = callData.get(callId);
    console.log(`   → Desconexión: ${reason}`);

    if (cd && !cd.logged) {
      const statusMap = { 'MANAGERHANGUP': 'completada', 'CALLERHANGUP': 'completada', 'NOCREDITPARTNER': 'sin_credito', 'GENERALERROR': 'error', 'TIMEOUT': 'no_contesto', 'NOANSWERTIMEOUT': 'no_contesto', 'CALLEEBUSY': 'ocupado' };
      const resultado = statusMap[reason] || reason || 'desconocido';
      // Solo loguear si no se logueó por PIE
      if (!cd.resultado) logResult(cd.campaignId, cd.index, null, resultado);
    }

    // Limpiar
    callData.delete(callId);
    return res.json({});
  }

  // ICE o ACE - Sinch los maneja con el customCallout, solo confirmar
  res.json({});
});

// ============================================================
// LOG RESULTADO → GAS Webhook
// ============================================================
function logResult(campaignId, index, menuValue, callStatus) {
  const camp = campaigns.get(campaignId);
  if (!camp || index === undefined) return;
  const cl = camp.clients[index];
  if (!cl) return;

  const resultado = menuValue || callStatus || 'sin_respuesta';
  cl.resultado = resultado;
  cl.logged = true;
  camp.completed = (camp.completed || 0) + 1;

  // También marcar en callData
  for (const [k, v] of callData) {
    if (v.campaignId === campaignId && v.index === index) v.resultado = resultado;
  }

  console.log(`📊 [${campaignId}] #${index} ${cl.nombre}: ${resultado}`);

  if (GAS_WEBHOOK_URL) {
    const payload = JSON.stringify({
      action: 'registrarLlamadaIVR',
      nombre: cl.nombre, telefono: cl.telefono,
      saldo: cl.saldo, diasAtraso: cl.diasAtraso,
      promotor: cl.promotor, resultado,
      detalle: menuValue ? `Seleccionó: ${menuValue}` : (callStatus || 'Sin respuesta'),
      cobrador: cl.cobrador || '', campaignId
    });
    const url = new URL(GAS_WEBHOOK_URL);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', e => console.error('GAS error:', e.message));
    req.write(payload);
    req.end();
  }
}

// ============================================================
// API: Lanzar campaña
// ============================================================
app.post('/api/campaign', auth, async (req, res) => {
  try {
    const { clients, message, delaySeconds = 15 } = req.body;
    if (!clients?.length) return res.status(400).json({ error: 'No hay clientes' });

    const campaignId = crypto.randomUUID().slice(0, 8);
    campaigns.set(campaignId, {
      clients, message, started: new Date().toISOString(),
      completed: 0, total: clients.length
    });

    res.json({ campaignId, total: clients.length, status: 'iniciada' });

    // Procesar llamadas
    for (let idx = 0; idx < clients.length; idx++) {
      const cl = clients[idx];
      const camp = campaigns.get(campaignId);
      if (!camp || camp.cancelled) break;

      try {
        const nombre = (cl.nombre || 'Cliente').split(' ')[0];
        const saldo = cl.saldo || '0';
        const dias = cl.diasAtraso || '0';
        const texto = message
          ? message.replace(/{nombre}/g, nombre).replace(/{saldo}/g, saldo).replace(/{dias}/g, dias)
          : `${nombre}, le llamamos de LeGaXi Asociados. Su cuenta tiene un saldo vencido de ${saldo} pesos con ${dias} días de atraso. Presione 1 para agendar promesa de pago. Presione 2 para hablar con su asesor. Presione 3 si ya realizó su pago.`;

        let phone = (cl.telefono || '').replace(/\D/g, '');
        if (phone.length === 10) phone = '52' + phone;
        if (!phone.startsWith('+')) phone = '+' + phone;

        console.log(`📱 [${campaignId}] Llamando ${idx + 1}/${clients.length}: ${cl.nombre} → ${phone}`);
        await sinchCallWithIVR(phone, texto, campaignId, idx, cl);
      } catch (err) {
        console.error(`❌ Error llamada ${idx}:`, err.message);
        logResult(campaignId, idx, null, 'error');
      }

      if (idx < clients.length - 1) {
        await new Promise(r => setTimeout(r, (delaySeconds || 15) * 1000));
      }
    }
    console.log(`✅ Campaña ${campaignId} completada`);
  } catch (err) {
    console.error('Campaign error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ============================================================
// API: Estado, cancelar, test, config
// ============================================================
app.get('/api/campaign/:id', auth, (req, res) => {
  const camp = campaigns.get(req.params.id);
  if (!camp) return res.status(404).json({ error: 'No encontrada' });
  res.json({
    campaignId: req.params.id, total: camp.total,
    completed: camp.completed || 0, cancelled: !!camp.cancelled,
    clients: camp.clients.map(c => ({ nombre: c.nombre, telefono: c.telefono, resultado: c.resultado || 'pendiente' }))
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
    let p = (phone || '').replace(/\D/g, '');
    if (p.length === 10) p = '52' + p;
    if (!p.startsWith('+')) p = '+' + p;

    const texto = `Hola ${nombre}, esta es una prueba del sistema IVR de LeGaXi. Presione 1 para confirmar. Presione 2 para hablar con un asesor.`;
    const result = await sinchCallWithIVR(p, texto, 'test', 0, { nombre });
    res.json({ success: !result.error, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Llamada TTS simple (sin IVR)
app.post('/api/test-tts', auth, async (req, res) => {
  try {
    const { phone, text = 'Hola, esta es una prueba de LeGaXi.' } = req.body;
    let p = (phone || '').replace(/\D/g, '');
    if (p.length === 10) p = '52' + p;
    if (!p.startsWith('+')) p = '+' + p;
    const result = await sinchCallTTS(p, text);
    res.json({ success: !result.error, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/config', auth, (req, res) => {
  res.json({
    provider: 'sinch',
    sinch: { configured: !!(SINCH_APP_KEY && SINCH_APP_SECRET), number: SINCH_FROM_NUMBER },
    gas: { configured: !!GAS_WEBHOOK_URL },
    serverUrl: SERVER_URL,
    activeCalls: callData.size,
    activeCampaigns: campaigns.size
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', provider: 'sinch', uptime: Math.floor(process.uptime()) }));
app.get('/', (req, res) => res.json({ service: 'LeGaXi IVR v4.0 - Sinch', status: 'running' }));

// Servir panel
const panelPath = path.join(__dirname, 'panel.html');
if (fs.existsSync(panelPath)) app.get('/panel', (req, res) => res.sendFile(panelPath));

// ============================================================
app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   🚀 LeGaXi IVR v4.0 - SINCH                ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║ Puerto: ${PORT}`);
  console.log(`║ Sinch App: ${SINCH_APP_KEY ? '✅' : '❌'}`);
  console.log(`║ Número: ${SINCH_FROM_NUMBER}`);
  console.log(`║ Callbacks: ${SERVER_URL}/sinch`);
  console.log(`║ GAS: ${GAS_WEBHOOK_URL ? '✅' : '❌'}`);
  console.log('╚═══════════════════════════════════════════════╝');
});
