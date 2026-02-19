// ============================================================
// LeGaXi IVR PROPIO - Telnyx Call Control API
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
  TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_FROM_NUMBER,      // +525544621100
  GAS_WEBHOOK_URL,
  SERVER_URL,              // https://legaxi-ivr.onrender.com
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
const activeCalls = new Map(); // call_control_id -> { campaignId, index, clientData }

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

function buildMensaje(c) {
  const sF = Number(c.saldo).toLocaleString('es-MX', { minimumFractionDigits: 0 });
  const tF = Number(c.tarifa).toLocaleString('es-MX', { minimumFractionDigits: 0 });
  const nom = (c.nombre || '').replace(/[°•*"\\#]/g, '').split(' ')[0];
  return `Buenas tardes. Le llamamos de LeGaXi Asociados. LMV Credia asignó su pagaré para cobro, por un adeudo de ${sF} pesos, con ${c.diasAtraso} días de atraso. ${nom}, su pago mínimo es de ${tF} pesos. Para hacer una promesa de pago, marque 1. Para hablar con su gestor, marque 2. Si ya realizó su pago, marque 3.`;
}

function buildRespuesta(digit, nombre) {
  const n = (nombre || 'Cliente').split(' ')[0];
  switch (digit) {
    case '1': return `Gracias ${n}. Hemos registrado su promesa de pago. Un gestor le contactará pronto para confirmar los detalles. Hasta luego.`;
    case '2': return `Entendido ${n}. Lo estamos comunicando con su gestor. Por favor espere.`;
    case '3': return `Gracias ${n}. Registramos que usted ya realizó su pago. Verificaremos en nuestro sistema. Buen día.`;
    default: return `Opción no válida. Le contactaremos pronto. Hasta luego.`;
  }
}

// ============================================================
// TELNYX CALL CONTROL - Hacer llamada
// ============================================================
async function telnyxCall(phone, campaignId, index) {
  const resp = await fetch('https://api.telnyx.com/v2/calls', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TELNYX_API_KEY}`
    },
    body: JSON.stringify({
      connection_id: TELNYX_CONNECTION_ID,
      to: phone,
      from: TELNYX_FROM_NUMBER,
      answering_machine_detection: 'disabled',
      webhook_url: `${SERVER_URL}/telnyx/webhook`,
      webhook_url_method: 'POST',
      client_state: Buffer.from(JSON.stringify({ campaignId, index })).toString('base64'),
      timeout_secs: 25
    })
  });

  const data = await resp.json();
  if (data.data && data.data.call_control_id) {
    console.log(`📞 Llamando: campaña=${campaignId} index=${index} callId=${data.data.call_control_id}`);
  }
  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors[0].detail || 'Error en llamada Telnyx');
  }
  return data;
}

// ============================================================
// TELNYX CALL CONTROL - Comandos
// ============================================================
async function telnyxCommand(callControlId, command, params = {}) {
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/${command}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TELNYX_API_KEY}`
    },
    body: JSON.stringify(params)
  });
  const data = await resp.json();
  if (data.errors && data.errors.length > 0) {
    console.error(`Telnyx ${command} error:`, data.errors[0].detail);
  }
  return data;
}

// ============================================================
// WEBHOOK - Telnyx envía eventos aquí
// ============================================================
app.post('/telnyx/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido

  const event = req.body.data;
  if (!event) return;

  const eventType = event.event_type;
  const callControlId = event.payload?.call_control_id;
  const clientStateB64 = event.payload?.client_state;

  let state = {};
  if (clientStateB64) {
    try { state = JSON.parse(Buffer.from(clientStateB64, 'base64').toString()); } catch(e) {}
  }

  const { campaignId, index } = state;
  const campaign = campaigns.get(campaignId);
  const clientData = campaign?.clients?.[parseInt(index)];

  console.log(`📩 Evento: ${eventType} | Campaña: ${campaignId} | Index: ${index}`);

  try {
    switch (eventType) {
      case 'call.initiated':
        // Llamada iniciada, esperando que contesten
        if (callControlId) {
          activeCalls.set(callControlId, { campaignId, index, clientData });
        }
        break;

      case 'call.answered': {
        // ¡Contestaron! Generar y reproducir audio
        // Si no hay clientData, es una llamada transferida (gestor) — no hacer nada
        if (!clientData) {
          console.log(`📲 Gestor contestó la transferencia — no interferir`);
          break;
        }

        const msg = buildMensaje(clientData);
        const hash = crypto.createHash('md5').update(msg).digest('hex');
        const audioFile = `msg_${hash}.mp3`;
        let audioUrl;

        try {
          audioUrl = await generateAudio(msg, audioFile);
        } catch (e) {
          console.error('TTS error:', e.message);
          audioUrl = null;
        }

        if (audioUrl) {
          // Reproducir audio y capturar DTMF
          await telnyxCommand(callControlId, 'gather_using_audio', {
            audio_url: audioUrl,
            minimum_digits: 1,
            maximum_digits: 1,
            timeout_millis: 12000,
            inter_digit_timeout_millis: 5000,
            valid_digits: '123',
            client_state: clientStateB64
          });
        } else {
          // Fallback: usar TTS de Telnyx (speak)
          await telnyxCommand(callControlId, 'gather_using_speak', {
            payload: msg,
            voice: 'female',
            language: 'es-MX',
            minimum_digits: 1,
            maximum_digits: 1,
            timeout_millis: 12000,
            inter_digit_timeout_millis: 5000,
            valid_digits: '123',
            client_state: clientStateB64
          });
        }
        break;
      }

      case 'call.gather.ended': {
        // El cliente presionó una tecla
        const digits = event.payload?.digits;
        const nombre = clientData?.nombre || 'Cliente';

        if (digits) {
          const resultMap = { '1': 'promesa_pago', '2': 'transferencia', '3': 'ya_pago' };
          const detalleMap = { '1': 'Promesa de pago', '2': 'Pidió hablar con gestor', '3': 'Ya pagó' };
          logResult(campaignId, index, resultMap[digits] || 'opcion_invalida', detalleMap[digits] || `Tecla: ${digits}`);

          if (digits === '2') {
            // TRANSFERENCIA EN VIVO al gestor
            const gestorPhone = getGestorPhone(clientData?.promotor);
            const respMsg = buildRespuesta('2', nombre);
            
            try {
              const respHash = crypto.createHash('md5').update(respMsg).digest('hex');
              const respUrl = await generateAudio(respMsg, `resp_${respHash}.mp3`);
              // Reproducir mensaje antes de transferir
              await telnyxCommand(callControlId, 'playback_start', {
                audio_url: respUrl,
                client_state: Buffer.from(JSON.stringify({ campaignId, index, action: 'transfer', gestorPhone })).toString('base64')
              });
            } catch (e) {
              await telnyxCommand(callControlId, 'speak', {
                payload: respMsg,
                voice: 'female',
                language: 'es-MX',
                client_state: Buffer.from(JSON.stringify({ campaignId, index, action: 'transfer', gestorPhone })).toString('base64')
              });
            }
          } else {
            // Teclas 1, 3 u otra - reproducir respuesta y colgar después
            const respMsg = buildRespuesta(digits, nombre);
            const respHash = crypto.createHash('md5').update(respMsg).digest('hex');
            const respFile = `resp_${respHash}.mp3`;
            const hangupState = Buffer.from(JSON.stringify({ campaignId, index, action: 'hangup' })).toString('base64');

            try {
              const respUrl = await generateAudio(respMsg, respFile);
              await telnyxCommand(callControlId, 'playback_start', {
                audio_url: respUrl,
                client_state: hangupState
              });
            } catch (e) {
              await telnyxCommand(callControlId, 'speak', {
                payload: respMsg,
                voice: 'female',
                language: 'es-MX',
                client_state: hangupState
              });
            }
          }
        } else {
          // No presionó nada (timeout)
          logResult(campaignId, index, 'sin_respuesta', 'No presionó ninguna tecla');
          const hangupState = Buffer.from(JSON.stringify({ campaignId, index, action: 'hangup' })).toString('base64');
          try {
            const noRespMsg = 'No recibimos su respuesta. Le volveremos a contactar. Hasta luego.';
            const noRespHash = crypto.createHash('md5').update(noRespMsg).digest('hex');
            const noRespUrl = await generateAudio(noRespMsg, `noresp_${noRespHash}.mp3`);
            await telnyxCommand(callControlId, 'playback_start', {
              audio_url: noRespUrl,
              client_state: hangupState
            });
          } catch (e) {
            await telnyxCommand(callControlId, 'speak', {
              payload: 'No recibimos su respuesta. Hasta luego.',
              voice: 'female',
              language: 'es-MX',
              client_state: hangupState
            });
          }
        }
        break;
      }

      case 'call.playback.ended':
      case 'call.speak.ended': {
        // Solo actuar si hay una acción pendiente en el state
        if (state.action === 'transfer' && state.gestorPhone) {
          // Transferir al gestor EN VIVO
          console.log(`📲 Transfiriendo a gestor: ${state.gestorPhone}`);
          await telnyxCommand(callControlId, 'transfer', {
            to: state.gestorPhone,
            from: TELNYX_FROM_NUMBER,
            timeout_secs: 30,
            client_state: clientStateB64
          });
        } else if (state.action === 'hangup') {
          // Respuesta terminó, ahora sí colgar
          await telnyxCommand(callControlId, 'hangup', { client_state: clientStateB64 });
        }
        // Si no hay action, es el playback del gather — NO hacer nada, esperar DTMF
        break;
      }

      case 'call.hangup':
      case 'call.machine.detection.ended':
        // Llamada terminó
        if (callControlId) activeCalls.delete(callControlId);
        
        // Ignorar hangups de llamadas sin campaña (transferencias a gestores)
        if (!campaignId || !campaign) break;

        const hangupCause = event.payload?.hangup_cause;
        if (hangupCause && hangupCause !== 'normal_clearing' && hangupCause !== 'originator_cancel') {
          const causeMap = {
            'user_busy': 'ocupado',
            'no_answer': 'no_contesto',
            'call_rejected': 'rechazada',
            'unallocated_number': 'numero_invalido',
            'network_failure': 'fallida'
          };
          const resultado = causeMap[hangupCause] || hangupCause;
          // Solo loguear si no hay resultado previo para esta llamada
          if (campaign && !campaign.results.find(r => r.index === index && r.resultado !== 'error')) {
            logResult(campaignId, index, resultado, `Causa: ${hangupCause}`);
          }
        }
        break;

      default:
        console.log(`   Evento no manejado: ${eventType}`);
    }
  } catch (err) {
    console.error(`Error procesando evento ${eventType}:`, err.message);
  }
});

// ============================================================
// GESTORES
// ============================================================
function getGestorPhone(promotor) {
  const gestores = {
    // Gestores principales
    'Juan Carlos': '+525515838763',
    'Lic. Juan Carlos': '+525515838763',
    'Nery': '+525521975037',
    'Lic. Nery': '+525521975037',
    // Cobradores LeGaXi (mapean al gestor más cercano)
    'Brenda Rosario Rojas Quijano': '+525515838763',
    'Luz María Valencia Quiroz': '+525521975037',
    'Dania Peñaloza del Rosario': '+525515838763',
    'Reyna Bautista Galvan': '+525521975037',
    'Yazmin Sanchez Ramirez': '+525515838763',
    'Daniel Martinez Pena': '+525521975037',
  };
  
  // Buscar coincidencia parcial
  if (promotor) {
    const key = Object.keys(gestores).find(k => 
      k.toLowerCase().includes(promotor.toLowerCase()) || 
      promotor.toLowerCase().includes(k.toLowerCase())
    );
    if (key) return gestores[key];
  }
  
  // Default: Lic. Juan Carlos
  return DEFAULT_GESTOR_PHONE || '+525515838763';
}

// ============================================================
// LOGGING → Google Sheets
// ============================================================
function logResult(campId, idx, resultado, detalle) {
  const camp = campaigns.get(campId);
  if (!camp) return;
  const cl = camp.clients[parseInt(idx)] || {};

  const entry = {
    campaignId: campId, index: idx,
    fecha: new Date().toISOString(),
    nombre: cl.nombre || '', telefono: cl.telefono || '',
    saldo: cl.saldo || 0, diasAtraso: cl.diasAtraso || 0,
    promotor: cl.promotor || '', resultado, detalle,
    cobrador: camp.cobrador
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
// HACER LLAMADA (con formato de teléfono)
// ============================================================
async function makeCall(clientData, campaignId, index) {
  let phone = String(clientData.telefono).replace(/[^0-9]/g, '');
  if (phone.length === 10) phone = '52' + phone;
  if (!phone.startsWith('+')) phone = '+' + phone;
  if (phone.length < 12) throw new Error(`Tel inválido: ${clientData.telefono}`);

  return telnyxCall(phone, campaignId, index);
}

// ============================================================
// COLA DE LLAMADAS
// ============================================================
async function processQueue(campId) {
  const c = campaigns.get(campId);
  for (let i = 0; i < c.clients.length && c.status !== 'cancelled'; i++) {
    try {
      await makeCall(c.clients[i], campId, i);
    } catch (e) {
      console.error(`Error llamando ${c.clients[i].nombre}:`, e.message);
      logResult(campId, i, 'error', e.message);
    }
    c.completed++;

    // Esperar entre llamadas (evitar saturar)
    if (i < c.clients.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  if (c.status !== 'cancelled') c.status = 'completed';
  console.log(`✅ Campaña ${campId}: ${c.completed}/${c.total}`);
}

// ============================================================
// API ENDPOINTS
// ============================================================

// Iniciar campaña
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

// Status
app.get('/api/campaign/:id', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrada' });
  const { clients, ...safe } = c;
  res.json(safe);
});

// Cancelar
app.post('/api/campaign/:id/cancel', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrada' });
  c.status = 'cancelled';
  res.json({ success: true });
});

// Llamada de prueba
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

// Preview audio
app.post('/api/audio/preview', auth, async (req, res) => {
  try {
    const h = crypto.createHash('md5').update(req.body.text).digest('hex');
    const url = await generateAudio(req.body.text, `prev_${h}.mp3`);
    res.json({ success: true, audioUrl: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Config
app.get('/api/config', auth, (req, res) => {
  res.json({
    provider: 'telnyx',
    serverUrl: SERVER_URL,
    hasGAS: !!GAS_WEBHOOK_URL,
    fromNumber: TELNYX_FROM_NUMBER,
    connectionId: TELNYX_CONNECTION_ID ? '***configured***' : 'NOT SET'
  });
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', provider: 'telnyx',
    uptime: Math.floor(process.uptime()),
    activeCalls: activeCalls.size,
    campaigns: campaigns.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  const panelPath = path.join(__dirname, 'panel.html');
  if (fs.existsSync(panelPath)) {
    res.sendFile(panelPath);
  } else {
    res.json({ service: 'LeGaXi IVR Propio', status: 'running', provider: 'telnyx' });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 LeGaXi IVR PROPIO | Puerto ${PORT} | Telnyx Call Control`);
  console.log(`📞 From: ${TELNYX_FROM_NUMBER || 'NO CONFIGURADO'}`);
  console.log(`🌐 Server: ${SERVER_URL || 'NO CONFIGURADO'}`);
  console.log(`📊 GAS: ${GAS_WEBHOOK_URL ? 'OK' : 'NO CONFIGURADO'}`);
});