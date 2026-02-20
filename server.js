// ============================================================
// LeGaXi IVR PROPIO - SignalWire Compatibility API (cXML/LaML)
// Llamadas automáticas con IVR interactivo
// ============================================================
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const {
  SW_PROJECT_ID,         // 02c0fddc-b824-42f4-a3a5-02701ae32e93
  SW_API_TOKEN,          // PT5d55e752d42c...
  SW_SPACE_URL,          // legaxiii.signalwire.com
  SW_FROM_NUMBER,        // +1XXXXXXXXXX (número comprado en SignalWire)
  GAS_WEBHOOK_URL,
  SERVER_URL,            // https://legaxi-ivr.onrender.com
  API_KEY,
  DEFAULT_GESTOR_PHONE,
  PORT = 3000
} = process.env;

const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use('/audio', express.static(AUDIO_DIR));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  const k = req.headers['x-api-key'] || req.query.api_key;
  if (k !== API_KEY) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// Estado de campañas y llamadas activas
const campaigns = new Map();
const callDataMap = new Map(); // callSid -> { campaignId, index, clientData }

// ============================================================
// EDGE TTS - Audio personalizado GRATIS
// ============================================================
async function generateAudio(text, filename) {
  const fp = path.join(AUDIO_DIR, filename);
  if (fs.existsSync(fp) && fs.statSync(fp).size > 0 && (Date.now() - fs.statSync(fp).mtimeMs) < 86400000) {
    return `${SERVER_URL}/audio/${filename}`;
  }
  return new Promise((resolve, reject) => {
    const safe = text.replace(/"/g, '\\"').replace(/\n/g, ' ');
    exec(`edge-tts --voice "es-MX-DaliaNeural" --text "${safe}" --write-media "${fp}"`,
      { timeout: 30000 }, (err) => {
        if (err) reject(err);
        else resolve(`${SERVER_URL}/audio/${filename}`);
      });
  });
}

// ============================================================
// MENSAJES ESCALONADOS POR NIVEL DE ATRASO
// ============================================================
function buildMensaje(c) {
  const sF = Number(c.saldo).toLocaleString('es-MX', { minimumFractionDigits: 0 });
  const tF = Number(c.tarifa).toLocaleString('es-MX', { minimumFractionDigits: 0 });
  const nom = (c.nombre || '').replace(/[°•*"\\#]/g, '');
  const partes = nom.trim().split(/\s+/);
  const nombreCorto = partes[0];
  const dias = Number(c.diasAtraso) || 0;
  
  const saludo = getHoraSaludo();
  const opciones = `Para hacer una promesa de pago, marque 1. Para hablar con su gestor, marque 2. Si ya realizó su pago, marque 3.`;
  
  if (dias <= 15) {
    return `${saludo}. ¿Hablo con ${nom}? Le llamamos de LeGaXi Asociados. LMV Credia nos ha solicitado contactarle respecto a su pagaré, el cual presenta un saldo de ${sF} pesos con ${dias} días de atraso. ${nombreCorto}, su pago mínimo es de ${tF} pesos. Le invitamos a regularizar su situación para evitar cargos adicionales. ${opciones}`;
  }
  if (dias <= 30) {
    return `${saludo}. ¿Hablo con ${nom}? Le llamamos de LeGaXi Asociados en carácter de urgente. LMV Credia asignó su pagaré para cobro por un adeudo de ${sF} pesos. ${nombreCorto}, su cuenta tiene ${dias} días de atraso y esto está generando intereses y afectación a su historial crediticio. Su pago mínimo es de ${tF} pesos. Es importante que regularice su situación a la brevedad. ${opciones}`;
  }
  if (dias <= 60) {
    return `${saludo}. Esta llamada es para ${nom}. Le comunicamos de LeGaXi Asociados, despacho de cobranza autorizado por LMV Credia. Su pagaré presenta un adeudo vencido de ${sF} pesos con ${dias} días de atraso. ${nombreCorto}, le informamos que de no regularizar su cuenta, se procederá con las acciones de cobro correspondientes conforme a la ley. Su pago mínimo para evitar esto es de ${tF} pesos. ${opciones}`;
  }
  return `${saludo}. Esta llamada va dirigida a ${nom}. Le comunicamos de LeGaXi Asociados, despacho de cobranza legal autorizado por LMV Credia. Su pagaré con un adeudo de ${sF} pesos se encuentra vencido con ${dias} días de atraso. ${nombreCorto}, esta es una notificación formal. Su expediente está en proceso de ser turnado al área legal para iniciar las gestiones de cobro que correspondan. Aún está a tiempo de evitar costos adicionales. Su pago mínimo es de ${tF} pesos. ${opciones}`;
}

function getHoraSaludo() {
  const now = new Date();
  const mx = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const hora = mx.getHours();
  if (hora < 12) return 'Buenos días';
  if (hora < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function buildRespuesta(digit, nombre, dias) {
  const n = (nombre || 'Cliente').replace(/[°•*"\\#]/g, '').split(/\s+/)[0];
  const d = Number(dias) || 0;
  
  switch (digit) {
    case '1': {
      if (d <= 15) return `Gracias ${n}. Hemos registrado su promesa de pago. Un gestor le contactará para confirmar los detalles y apoyarle con su proceso. Que tenga buen día.`;
      if (d <= 30) return `${n}, hemos registrado su promesa de pago. Es muy importante que cumpla con el compromiso para evitar que su caso escale. Un gestor le contactará pronto para confirmar. Hasta luego.`;
      return `${n}, queda registrada su promesa de pago. Le recordamos que el incumplimiento de esta promesa podría acelerar las acciones de cobro. Un gestor le contactará para formalizar el acuerdo. Hasta luego.`;
    }
    case '2': return `Entendido ${n}. Lo estamos comunicando con su gestor asignado. Por favor no cuelgue.`;
    case '3': {
      if (d <= 30) return `Gracias ${n}. Registramos que ya realizó su pago. Lo verificaremos en nuestro sistema y se actualizará su cuenta. Buen día.`;
      return `${n}, tomamos nota de que indica haber realizado su pago. Nuestro equipo lo verificará. Si el pago no se confirma en las próximas 48 horas, se continuará con el proceso de cobro. Hasta luego.`;
    }
    default: return `${n}, no recibimos una opción válida. Un gestor se pondrá en contacto con usted. Hasta luego.`;
  }
}

// ============================================================
// GESTORES
// ============================================================
function getGestorPhone(promotor) {
  const gestores = {
    'Juan Carlos': '+525515838763',
    'Lic. Juan Carlos': '+525515838763',
    'Nery': '+525521975037',
    'Lic. Nery': '+525521975037',
    'Brenda Rosario Rojas Quijano': '+525515838763',
    'Luz María Valencia Quiroz': '+525521975037',
    'Abigail Ramos Molina': '+525515838763',
    'Antonio Yoab Galicia Flores': '+525521975037',
    'Araceli Garcia Evagelista': '+525515838763',
    'Claudia Ivette Pedroza': '+525521975037',
    'Dania Peñaloza del Rosario': '+525515838763',
    'Daniel Martinez Pena': '+525521975037',
    'Gregoria Sosa Tellez': '+525515838763',
    'Lariza Paola Romero Plaza': '+525521975037',
    'Miriam Martínez Rodriguez': '+525515838763',
    'Reyna Bautista Galvan': '+525521975037',
    'Yazmin Sanchez Ramirez': '+525515838763',
  };
  const key = (promotor || '').trim();
  return gestores[key] || DEFAULT_GESTOR_PHONE || '+525515838763';
}

function getNivelCobranza(dias) {
  if (dias <= 15) return 'NIVEL 1 - Recordatorio';
  if (dias <= 30) return 'NIVEL 2 - Urgente';
  if (dias <= 60) return 'NIVEL 3 - Presión';
  return 'NIVEL 4 - Legal';
}

function isHorarioPermitido() {
  const now = new Date();
  const mx = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const hora = mx.getHours();
  const dia = mx.getDay();
  if (dia === 0) return false;
  if (hora < 8 || hora >= 20) return false;
  return true;
}

// ============================================================
// SIGNALWIRE cXML WEBHOOKS
// ============================================================

// Webhook principal: cuando contestan la llamada
// SignalWire hace POST aquí pidiendo instrucciones XML
app.post('/sw/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  const callData = callDataMap.get(callSid);

  if (!callData || !callData.clientData) {
    // Llamada desconocida, colgar
    res.type('text/xml');
    return res.send('<Response><Hangup/></Response>');
  }

  const { clientData, campaignId, index } = callData;

  try {
    // Generar audio personalizado
    const msg = buildMensaje(clientData);
    const hash = crypto.createHash('md5').update(msg).digest('hex');
    const audioUrl = await generateAudio(msg, `msg_${hash}.mp3`);

    // Construir cXML: reproducir audio y recoger DTMF
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="12" action="${SERVER_URL}/sw/gather?cid=${campaignId}&idx=${index}">
    <Play>${audioUrl}</Play>
  </Gather>
  <Redirect>${SERVER_URL}/sw/noinput?cid=${campaignId}&idx=${index}</Redirect>
</Response>`;

    res.type('text/xml');
    res.send(xml);
    console.log(`📩 Contestaron: ${clientData.nombre} | ${getNivelCobranza(clientData.diasAtraso)}`);
  } catch (e) {
    // Fallback: usar Say de SignalWire
    const msg = buildMensaje(clientData);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="12" action="${SERVER_URL}/sw/gather?cid=${campaignId}&idx=${index}">
    <Say language="es-MX" voice="Polly.Mia">${escapeXml(msg)}</Say>
  </Gather>
  <Redirect>${SERVER_URL}/sw/noinput?cid=${campaignId}&idx=${index}</Redirect>
</Response>`;
    res.type('text/xml');
    res.send(xml);
  }
});

// Webhook: el deudor presionó una tecla
app.post('/sw/gather', async (req, res) => {
  const { cid, idx } = req.query;
  const digits = req.body.Digits;
  const campaignId = cid;
  const index = parseInt(idx);
  const campaign = campaigns.get(campaignId);
  const clientData = campaign?.clients?.[index];
  const nombre = clientData?.nombre || 'Cliente';
  const diasAtraso = clientData?.diasAtraso || 0;

  console.log(`🔢 Tecla ${digits} | ${nombre}`);

  const resultMap = { '1': 'promesa_pago', '2': 'transferencia', '3': 'ya_pago' };
  const detalleMap = { '1': 'Promesa de pago', '2': 'Pidió hablar con gestor', '3': 'Ya pagó' };
  logResult(campaignId, index, resultMap[digits] || 'opcion_invalida', detalleMap[digits] || `Tecla: ${digits}`);

  if (digits === '2') {
    // Registrar solicitud de callback del gestor (sin transferencia en vivo)
    const respMsg = `Entendido ${(nombre || 'Cliente').split(/\s+/)[0]}. Un gestor le llamará en los próximos minutos para atender su caso. Por favor mantenga su teléfono disponible. Hasta pronto.`;
    
    try {
      const respHash = crypto.createHash('md5').update(respMsg).digest('hex');
      const respUrl = await generateAudio(respMsg, `resp_${respHash}.mp3`);

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${respUrl}</Play>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      res.send(xml);
      console.log(`📲 Solicita gestor: ${nombre} | Promotor: ${clientData?.promotor}`);
    } catch (e) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Polly.Mia">${escapeXml(respMsg)}</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      res.send(xml);
    }
  } else {
    // Tecla 1, 3 u otra — reproducir respuesta y colgar
    const respMsg = buildRespuesta(digits, nombre, diasAtraso);
    
    try {
      const respHash = crypto.createHash('md5').update(respMsg).digest('hex');
      const respUrl = await generateAudio(respMsg, `resp_${respHash}.mp3`);

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${respUrl}</Play>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      res.send(xml);
    } catch (e) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Polly.Mia">${escapeXml(respMsg)}</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml');
      res.send(xml);
    }
  }
});

// Webhook: no presionó ninguna tecla (timeout)
app.post('/sw/noinput', async (req, res) => {
  const { cid, idx } = req.query;
  logResult(cid, parseInt(idx), 'sin_respuesta', 'No presionó ninguna tecla');

  try {
    const msg = 'No recibimos su respuesta. Le volveremos a contactar. Hasta luego.';
    const hash = crypto.createHash('md5').update(msg).digest('hex');
    const audioUrl = await generateAudio(msg, `noresp_${hash}.mp3`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Hangup/>
</Response>`;
    res.type('text/xml');
    res.send(xml);
  } catch (e) {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Polly.Mia">No recibimos su respuesta. Hasta luego.</Say>
  <Hangup/>
</Response>`);
  }
  console.log(`⏰ Sin respuesta | Campaña: ${cid}`);
});

// Webhook: status callback (para rastrear resultados)
app.post('/sw/status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const callData = callDataMap.get(callSid);

  if (callData) {
    const { campaignId, index } = callData;
    console.log(`📩 Status: ${callStatus} | ${callData.clientData?.nombre || 'N/A'}`);

    if (['busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
      const statusMap = {
        'busy': 'ocupado',
        'no-answer': 'no_contesto',
        'failed': 'fallida',
        'canceled': 'cancelada'
      };
      // Solo loguear si no hay resultado previo para esta llamada
      const campaign = campaigns.get(campaignId);
      const yaRegistrado = campaign?.results?.find(r => r.index == index && !['error'].includes(r.resultado));
      if (!yaRegistrado) {
        logResult(campaignId, index, statusMap[callStatus] || callStatus, `Causa: ${callStatus}`);
      }
    }

    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
      callDataMap.delete(callSid);
    }
  }

  res.sendStatus(200);
});

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ============================================================
// LOGGING Y GAS
// ============================================================
function logResult(campaignId, index, resultado, detalle) {
  const camp = campaigns.get(campaignId);
  if (!camp) return;
  const cl = camp.clients?.[index] || {};
  const entry = {
    fecha: new Date().toISOString(),
    nombre: cl.nombre || '', telefono: cl.telefono || '',
    saldo: cl.saldo || 0, diasAtraso: cl.diasAtraso || 0,
    promotor: cl.promotor || '', resultado, detalle,
    gestor: camp.cobrador, campaignId, index
  };
  camp.results.push(entry);
  console.log(`📋 ${entry.nombre}: ${resultado} - ${detalle}`);
  sendToGAS(entry).catch(e => console.error('GAS err:', e.message));
}

async function sendToGAS(entry) {
  if (!GAS_WEBHOOK_URL) return;
  const p = new URLSearchParams({
    action: 'registrarLlamadaIVR',
    ...Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, String(v)]))
  });
  try {
    await fetch(`${GAS_WEBHOOK_URL}?${p}`);
  } catch (e) { /* silently fail */ }
}

// ============================================================
// HACER LLAMADA VIA SIGNALWIRE
// ============================================================
async function makeCall(clientData, campaignId, index) {
  // Permitir bypass de horario para pruebas
  if (!clientData._skipHorario && !isHorarioPermitido()) {
    throw new Error('Fuera de horario permitido (Lun-Sáb 8am-8pm)');
  }

  let phone = String(clientData.telefono).replace(/[^0-9]/g, '');
  if (phone.length === 10) phone = '52' + phone;
  if (!phone.startsWith('+')) phone = '+' + phone;
  if (phone.length < 12) throw new Error(`Tel inválido: ${clientData.telefono}`);

  const nivel = getNivelCobranza(Number(clientData.diasAtraso) || 0);
  console.log(`📞 ${clientData.nombre} | ${nivel} | ${clientData.diasAtraso} días | $${clientData.saldo}`);

  // SignalWire Compatibility API - Create Call
  // Usar número mexicano verificado como CallerID
  const callerIdNumber = process.env.SW_CALLER_ID || SW_FROM_NUMBER;
  const swUrl = `https://${SW_SPACE_URL}/api/laml/2010-04-01/Accounts/${SW_PROJECT_ID}/Calls.json`;
  const authHeader = 'Basic ' + Buffer.from(`${SW_PROJECT_ID}:${SW_API_TOKEN}`).toString('base64');

  const body = new URLSearchParams({
    To: phone,
    From: callerIdNumber,
    Url: `${SERVER_URL}/sw/voice`,
    StatusCallback: `${SERVER_URL}/sw/status`,
    StatusCallbackEvent: 'completed',
    Timeout: '30'
  });

  const response = await fetch(swUrl, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SignalWire error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const callSid = data.sid;

  // Guardar datos de la llamada para cuando contesten
  callDataMap.set(callSid, { campaignId, index, clientData });
  
  console.log(`📞 Llamando: campaña=${campaignId} index=${index} callSid=${callSid}`);
  return { data };
}

// ============================================================
// COLA DE LLAMADAS CON REINTENTOS
// ============================================================
const RETRY_DELAY_MS = 2 * 60 * 60 * 1000; // 2 horas
const MAX_RETRIES = 3;
const RETRY_RESULTS = ['no_contesto', 'ocupado', 'sin_respuesta', 'timeout', 'fallida'];

async function processQueue(campId) {
  const c = campaigns.get(campId);
  
  console.log(`🚀 Campaña ${campId}: Ronda 1 - ${c.clients.length} clientes`);
  for (let i = 0; i < c.clients.length && c.status !== 'cancelled'; i++) {
    try {
      await makeCall(c.clients[i], campId, i);
    } catch (e) {
      console.error(`Error llamando ${c.clients[i].nombre}:`, e.message);
      logResult(campId, i, 'error', e.message);
    }
    c.completed++;
    if (i < c.clients.length - 1) {
      await new Promise(r => setTimeout(r, 8000)); // 8 seg entre llamadas
    }
  }
  
  console.log(`✅ Campaña ${campId}: Ronda 1 completada ${c.completed}/${c.total}`);
  
  for (let retry = 1; retry <= MAX_RETRIES && c.status !== 'cancelled'; retry++) {
    const pendientes = [];
    for (let i = 0; i < c.clients.length; i++) {
      const resultados = c.results.filter(r => r.index == i);
      if (resultados.length === 0) continue;
      const ultimo = resultados[resultados.length - 1];
      if (RETRY_RESULTS.includes(ultimo.resultado)) {
        pendientes.push(i);
      }
    }
    
    if (pendientes.length === 0) {
      console.log(`✅ Campaña ${campId}: Sin pendientes para reintento ${retry}`);
      break;
    }
    
    const esperaMin = Math.round(RETRY_DELAY_MS / 60000);
    console.log(`⏳ Campaña ${campId}: Reintento ${retry}/${MAX_RETRIES} en ${esperaMin} min para ${pendientes.length} clientes`);
    
    c.status = `esperando_reintento_${retry}`;
    c.nextRetry = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
    c.retryPendientes = pendientes.length;
    c.retryNumero = retry;
    
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    
    if (c.status === 'cancelled') break;
    if (!isHorarioPermitido()) {
      console.log(`⏰ Campaña ${campId}: Fuera de horario, cancelando reintentos`);
      break;
    }
    
    c.status = `reintento_${retry}`;
    console.log(`🔄 Campaña ${campId}: Ronda ${retry + 1} - ${pendientes.length} reintentos`);
    
    for (let j = 0; j < pendientes.length && c.status !== 'cancelled'; j++) {
      const idx = pendientes[j];
      try {
        await makeCall(c.clients[idx], campId, idx);
      } catch (e) {
        console.error(`Error reintento ${c.clients[idx].nombre}:`, e.message);
        logResult(campId, idx, 'error', `Reintento ${retry}: ${e.message}`);
      }
      if (j < pendientes.length - 1) {
        await new Promise(r => setTimeout(r, 8000));
      }
    }
    
    console.log(`✅ Campaña ${campId}: Reintento ${retry} completado`);
  }
  
  if (c.status !== 'cancelled') c.status = 'completed';
  c.nextRetry = null;
  c.retryPendientes = 0;
  
  const promesas = c.results.filter(r => r.resultado === 'promesa_pago').length;
  const pagos = c.results.filter(r => r.resultado === 'ya_pago').length;
  const transfers = c.results.filter(r => r.resultado === 'transferencia').length;
  console.log(`🏁 Campaña ${campId} FINALIZADA | Promesas: ${promesas} | Ya pagó: ${pagos} | Transferencias: ${transfers}`);
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.post('/api/campaign/start', auth, async (req, res) => {
  const { clients, cobrador, campaignName } = req.body;
  if (!clients?.length) return res.status(400).json({ error: 'Sin clientes' });

  const id = `camp_${Date.now()}`;
  const camp = {
    id, name: campaignName || `Campaña ${new Date().toLocaleDateString('es-MX')}`,
    cobrador: cobrador || 'Sistema', status: 'running',
    total: clients.length, completed: 0, results: [], clients,
    created: new Date().toISOString()
  };
  campaigns.set(id, camp);
  processQueue(id).catch(e => { console.error(e); camp.status = 'error'; });
  res.json({ success: true, campaignId: id, total: clients.length });
});

app.get('/api/campaign/:id', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrada' });
  const { clients, ...safe } = c;
  res.json(safe);
});

app.post('/api/campaign/:id/cancel', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrada' });
  c.status = 'cancelled';
  res.json({ success: true });
});

app.post('/api/call/test', auth, async (req, res) => {
  const cd = req.body;
  const id = `test_${Date.now()}`;
  campaigns.set(id, {
    id, name: 'Test', cobrador: 'Admin', status: 'running',
    total: 1, completed: 0, results: [], clients: [cd],
    created: new Date().toISOString()
  });
  try {
    const result = await makeCall(cd, id, 0);
    res.json({ success: true, campaignId: id, callData: result.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/audio/preview', auth, async (req, res) => {
  try {
    const h = crypto.createHash('md5').update(req.body.text).digest('hex');
    const url = await generateAudio(req.body.text, `prev_${h}.mp3`);
    res.json({ success: true, audioUrl: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', auth, (req, res) => {
  res.json({
    provider: 'signalwire',
    serverUrl: SERVER_URL,
    hasGAS: !!GAS_WEBHOOK_URL,
    fromNumber: SW_FROM_NUMBER,
    spaceUrl: SW_SPACE_URL || 'NOT SET'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', provider: 'signalwire',
    uptime: Math.floor(process.uptime()),
    activeCalls: callDataMap.size,
    campaigns: campaigns.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  const panelPath = path.join(__dirname, 'panel.html');
  if (fs.existsSync(panelPath)) {
    res.sendFile(panelPath);
  } else {
    res.json({ service: 'LeGaXi IVR Propio', status: 'running', provider: 'signalwire' });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 LeGaXi IVR PROPIO | Puerto ${PORT} | SignalWire`);
  console.log(`📞 From: ${SW_FROM_NUMBER || 'NO CONFIGURADO'}`);
  console.log(`🌐 Server: ${SERVER_URL || 'NO CONFIGURADO'}`);
  console.log(`🏢 Space: ${SW_SPACE_URL || 'NO CONFIGURADO'}`);
  console.log(`📊 GAS: ${GAS_WEBHOOK_URL ? 'OK' : 'NO CONFIGURADO'}`);
});
