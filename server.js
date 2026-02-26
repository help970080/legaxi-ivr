// ============================================================
// LeGaXi IVR v6.0 - ZADARMA WEBHOOK IVR
// Llamadas salientes con IVR dinámico controlado por webhook
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
  ZADARMA_SIP = '100',              // Extensión PBX (no SIP directo)
  ZADARMA_CALLER_ID = '+525598160911',
  ZADARMA_SCENARIO = '0-1',         // Escenario PBX formato menu-scenario
  IVR_FILE_ID = '',                  // ID del archivo de audio IVR (se obtiene de Zadarma)
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

// ---- ZADARMA API (implementación nativa) ----
// Firma Zadarma: HMAC-SHA1 → hex string → base64 (NO binary→base64)
// El paquete npm zadarma usa este mismo método y ES correcto para Zadarma

function zadarmaRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sortedParams = {};
    Object.keys(params).sort().forEach(k => sortedParams[k] = params[k]);

    // http_build_query equivalente (RFC1738: spaces as %20)
    let paramsStr = '';
    if (Object.keys(sortedParams).length > 0) {
      paramsStr = Object.entries(sortedParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    }

    // Firma: method + paramsStr + md5(paramsStr)
    const md5 = crypto.createHash('md5').update(paramsStr).digest('hex');
    const data = method + paramsStr + md5;

    // HMAC-SHA1 → hex string → base64 (así lo espera Zadarma)
    const sha1hex = crypto.createHmac('sha1', ZADARMA_API_SECRET)
      .update(data)
      .digest('hex');
    const signature = Buffer.from(sha1hex).toString('base64');

    const authHeader = `${ZADARMA_API_KEY}:${signature}`;
    // Zadarma funciona con GET + query string (POST con body da "Wrong parameters")
    const urlPath = paramsStr ? `${method}?${paramsStr}` : method;

    console.log(`   🔑 API GET ${method}`);
    console.log(`   📦 paramsStr: ${paramsStr}`);

    const options = {
      hostname: 'api.zadarma.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { resolve({ status: 'error', raw: body }); }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ---- STORAGE ----
const campaigns = new Map();
const activeCalls = new Map();       // key: pbx_call_id → callData
const phoneToCall = new Map();       // key: phone → callData (lookup rápido)

// ============================================================
// HACER LLAMADA SALIENTE
// Usa callback con predicted + from=escenario PBX
// El cliente contesta → entra al IVR de la centralita
// Nuestro webhook controla qué escucha
// ============================================================
async function makeCall(phone, campaignId, index, clientData) {
  let cleanPhone = (phone || '').replace(/\D/g, '');

  // Zadarma con prefijo MX configurado: solo 10 dígitos
  if (cleanPhone.startsWith('+52')) cleanPhone = cleanPhone.substring(3);
  if (cleanPhone.startsWith('52') && cleanPhone.length === 12) cleanPhone = cleanPhone.substring(2);
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
  // Asegurar 10 dígitos
  if (cleanPhone.length > 10) cleanPhone = cleanPhone.slice(-10);

  const params = {
    from: ZADARMA_SCENARIO,   // Menú IVR 0 con audio grabado
    to: cleanPhone,
    sip: ZADARMA_SIP,
    predicted: 'predicted'    // Llama primero al deudor, luego lo conecta al IVR
  };

  console.log(`📞 [${campaignId}] #${index} Llamando ${clientData.nombre} → ${cleanPhone}`);
  console.log(`   📋 Params: from=${params.from} to=${params.to} sip=${params.sip} predicted`);

  try {
    const result = await zadarmaRequest('/v1/request/callback/', params);

    if (result.status === 'success') {
      const callInfo = {
        campaignId, index, phone: cleanPhone,
        nombre: clientData.nombre,
        saldo: clientData.saldo || '',
        diasAtraso: clientData.diasAtraso || '',
        promotor: clientData.promotor || '',
        cobrador: clientData.cobrador || '',
        startTime: Date.now(),
        resultado: 'pendiente',
        dtmf: null,
        logged: false
      };

      // Guardamos por teléfono para match con webhooks
      phoneToCall.set(cleanPhone, callInfo);
      // También guardamos las últimas 4-6 cifras por si el caller_id viene parcial
      if (cleanPhone.length >= 10) {
        phoneToCall.set(cleanPhone.slice(-10), callInfo);
      }

      console.log(`   ✅ Callback enviado exitosamente`);
      return { success: true, result };
    } else {
      console.log(`   ❌ Error API: ${JSON.stringify(result)}`);
      logResult(campaignId, index, null, 'error_api', clientData);
      return { success: false, result };
    }
  } catch (err) {
    console.error(`   ❌ Exception: ${err.message}`);
    logResult(campaignId, index, null, 'error_exception', clientData);
    return { success: false, error: err.message };
  }
}

// ============================================================
// BUSCAR LLAMADA ACTIVA por caller_id o destination
// ============================================================
function findCallByPhone(phoneHint) {
  if (!phoneHint) return null;
  const clean = phoneHint.replace(/\D/g, '');

  // Búsqueda directa
  if (phoneToCall.has(clean)) return phoneToCall.get(clean);

  // Búsqueda por últimos 10 dígitos
  const last10 = clean.slice(-10);
  if (phoneToCall.has(last10)) return phoneToCall.get(last10);

  // Búsqueda parcial
  for (const [key, call] of phoneToCall) {
    if (key.includes(clean) || clean.includes(key)) return call;
  }

  return null;
}

// ============================================================
// ZADARMA WEBHOOKS - EL CORAZÓN DEL IVR
// ============================================================
app.post('/zadarma', (req, res) => {
  const event = req.body.event;
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`\n📨 [${timestamp}] Webhook: ${event}`);
  console.log(`   Body: ${JSON.stringify(req.body).substring(0, 600)}`);

  // --------------------------------------------------------
  // NOTIFY_START - Inicio de llamada entrante a PBX
  // Cuando el cliente contesta (predicted), la llamada
  // entra a la PBX y recibimos este evento.
  // Respondemos con IVR: reproducir audio + esperar DTMF
  // --------------------------------------------------------
  if (event === 'NOTIFY_START') {
    const callerId = req.body.caller_id;
    const calledDid = req.body.called_did;
    const pbxCallId = req.body.pbx_call_id;

    console.log(`   📱 Llamada iniciada: caller=${callerId} did=${calledDid} pbx_id=${pbxCallId}`);

    const call = findCallByPhone(callerId);
    if (call) {
      call.pbxCallId = pbxCallId;
      activeCalls.set(pbxCallId, call);
      console.log(`   🔗 Match encontrado: ${call.nombre} (${call.phone})`);
    } else {
      console.log(`   ⚠️ Sin match para ${callerId} - puede ser llamada entrante directa`);
    }

    // RESPUESTA IVR: Reproducir audio del menú y esperar DTMF
    const ivrResponse = buildIvrResponse(call);
    console.log(`   🔊 Respuesta IVR: ${JSON.stringify(ivrResponse)}`);

    res.set('Content-Type', 'application/json');
    return res.json(ivrResponse);
  }

  // --------------------------------------------------------
  // NOTIFY_IVR - El cliente presionó una tecla DTMF
  // Procesamos la selección del menú
  // --------------------------------------------------------
  if (event === 'NOTIFY_IVR') {
    const pbxCallId = req.body.pbx_call_id;
    const callerId = req.body.caller_id;

    // Extraer DTMF de la estructura wait_dtmf
    let dtmf = null;
    if (req.body.wait_dtmf) {
      dtmf = req.body.wait_dtmf.digits;
    } else if (req.body.dtmf) {
      dtmf = req.body.dtmf;
    }

    console.log(`   🔢 IVR: DTMF="${dtmf}" caller=${callerId} pbx_id=${pbxCallId}`);

    const call = activeCalls.get(pbxCallId) || findCallByPhone(callerId);

    if (dtmf && call && !call.logged) {
      call.dtmf = dtmf;

      switch (dtmf) {
        case '1': // PAGAR
          console.log(`   💰 ${call.nombre} seleccionó PAGAR`);
          logResult(call.campaignId, call.index, 'pago', 'contestó', call);

          // Responder: mensaje de confirmación y colgar
          // O redirigir a extensión de asesor
          res.set('Content-Type', 'application/json');
          return res.json({
            ivr_saypopular: 17,  // "Thank you" / usar número de frase popular
            language: 'es',
            hangup: 1
          });

        case '2': // PROMESA DE PAGO
          console.log(`   📅 ${call.nombre} seleccionó PROMESA DE PAGO`);
          logResult(call.campaignId, call.index, 'promesa_pago', 'contestó', call);

          res.set('Content-Type', 'application/json');
          return res.json({
            hangup: 1
          });

        case '3': // HABLAR CON ASESOR → redirigir a extensión 100 (MicroSIP)
          console.log(`   🧑‍💼 ${call.nombre} quiere hablar con ASESOR → Ext 100`);
          logResult(call.campaignId, call.index, 'asesor', 'contestó', call);

          res.set('Content-Type', 'application/json');
          return res.json({
            redirect: ZADARMA_SIP,  // Extensión 100 (MicroSIP)
            return_timeout: 30      // 30 seg antes de volver al menú
          });

        default:
          console.log(`   ❓ Tecla no reconocida: ${dtmf}`);
          // Repetir el menú
          const retryResponse = buildIvrResponse(call);
          res.set('Content-Type', 'application/json');
          return res.json(retryResponse);
      }
    } else if (!dtmf || (req.body.wait_dtmf && req.body.wait_dtmf.default_behaviour)) {
      // Timeout o sin respuesta - colgar
      console.log(`   ⏰ Sin respuesta DTMF, colgando`);
      if (call && !call.logged) {
        logResult(call.campaignId, call.index, 'sin_respuesta', 'timeout_ivr', call);
      }
      res.set('Content-Type', 'application/json');
      return res.json({ hangup: 1 });
    }

    return res.json({});
  }

  // --------------------------------------------------------
  // NOTIFY_END - Fin de llamada entrante a PBX
  // --------------------------------------------------------
  if (event === 'NOTIFY_END') {
    const pbxCallId = req.body.pbx_call_id;
    const callerId = req.body.caller_id;
    const duration = parseInt(req.body.duration) || 0;
    const disposition = req.body.disposition;

    console.log(`   📴 Fin llamada: caller=${callerId} dur=${duration}s disp=${disposition}`);

    const call = activeCalls.get(pbxCallId) || findCallByPhone(callerId);

    if (call && !call.logged) {
      const resultado = duration > 0 && disposition === 'answered'
        ? 'contactado_sin_seleccion'
        : 'no_contesto';
      logResult(call.campaignId, call.index, resultado, disposition, call);
    }

    // Limpiar
    if (pbxCallId) activeCalls.delete(pbxCallId);
    if (call) {
      phoneToCall.delete(call.phone);
      if (call.phone.length >= 10) phoneToCall.delete(call.phone.slice(-10));
    }
  }

  // --------------------------------------------------------
  // NOTIFY_OUT_START - Inicio llamada saliente
  // --------------------------------------------------------
  if (event === 'NOTIFY_OUT_START') {
    const dest = req.body.destination;
    const callerId = req.body.caller_id;
    console.log(`   📤 Saliente iniciada: de=${callerId} a=${dest}`);
  }

  // --------------------------------------------------------
  // NOTIFY_OUT_END - Fin llamada saliente
  // --------------------------------------------------------
  if (event === 'NOTIFY_OUT_END') {
    const dest = req.body.destination;
    const duration = parseInt(req.body.duration) || 0;
    const disposition = req.body.disposition;
    console.log(`   📤 Saliente fin: dest=${dest} dur=${duration}s disp=${disposition}`);

    if (duration === 0) {
      const call = findCallByPhone(dest);
      if (call && !call.logged) {
        logResult(call.campaignId, call.index, 'no_contesto', disposition, call);
        phoneToCall.delete(call.phone);
      }
    }
  }

  res.json({});
});

// Zadarma webhook verification (GET con zd_echo)
app.get('/zadarma', (req, res) => {
  if (req.query.zd_echo) {
    console.log(`✅ Zadarma webhook verificado: ${req.query.zd_echo}`);
    return res.send(req.query.zd_echo);
  }
  res.json({ status: 'ok', webhook: 'zadarma', uptime: Math.floor(process.uptime()) });
});

// ============================================================
// CONSTRUIR RESPUESTA IVR
// ============================================================
function buildIvrResponse(call) {
  // Si tenemos archivo de audio IVR subido a Zadarma, usarlo
  if (IVR_FILE_ID) {
    return {
      ivr_play: IVR_FILE_ID,
      wait_dtmf: {
        timeout: 8,
        attempts: 2,
        maxsymbols: 1,
        name: 'menu_cobranza',
        default_behaviour: 'hangup'
      }
    };
  }

  // Si no hay archivo, usar texto a voz (readtext)
  // Zadarma puede leer texto automáticamente
  const nombre = call ? call.nombre : 'estimado cliente';
  const saldo = call ? call.saldo : '';

  // Construir mensaje personalizado
  let mensaje = `Estimado ${nombre}. `;
  if (saldo) {
    mensaje += `Usted tiene un saldo pendiente de ${saldo} pesos. `;
  } else {
    mensaje += `Usted tiene un saldo pendiente con LeGaXi. `;
  }
  mensaje += 'Presione 1 para realizar su pago. ';
  mensaje += 'Presione 2 para agendar una fecha de pago. ';
  mensaje += 'Presione 3 para hablar con un asesor.';

  return {
    ivr_saytext: mensaje,
    language: 'es',
    wait_dtmf: {
      timeout: 8,
      attempts: 2,
      maxsymbols: 1,
      name: 'menu_cobranza',
      default_behaviour: 'hangup'
    }
  };
}

// ============================================================
// LOG RESULTADO → GOOGLE APPS SCRIPT
// ============================================================
function logResult(campaignId, index, menuResult, callStatus, clientData) {
  // Buscar en campaña si existe
  const camp = campaigns.get(campaignId);
  let cl = clientData;

  if (camp && camp.clients[index]) {
    cl = camp.clients[index];
    if (cl.logged) return; // Ya logueado
    cl.logged = true;
    cl.resultado = menuResult || callStatus || 'sin_respuesta';
    camp.completed = (camp.completed || 0) + 1;
  }

  const resultado = menuResult || callStatus || 'sin_respuesta';
  console.log(`📊 [${campaignId}] #${index} ${cl?.nombre || '?'}: ${resultado}`);

  // Enviar a Google Apps Script
  if (GAS_WEBHOOK_URL && cl) {
    const payload = JSON.stringify({
      action: 'registrarLlamadaIVR',
      nombre: cl.nombre || '',
      telefono: cl.telefono || cl.phone || '',
      saldo: cl.saldo || '',
      diasAtraso: cl.diasAtraso || '',
      promotor: cl.promotor || '',
      cobrador: cl.cobrador || '',
      resultado,
      detalle: menuResult ? `IVR opción: ${menuResult}` : (callStatus || 'Sin respuesta'),
      campaignId,
      timestamp: new Date().toISOString()
    });

    try {
      const url = new URL(GAS_WEBHOOK_URL);
      const gasReq = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      });
      gasReq.on('error', e => console.error('   ❌ GAS error:', e.message));
      gasReq.write(payload);
      gasReq.end();
      console.log(`   📤 Enviado a GAS`);
    } catch (e) {
      console.error('   ❌ GAS exception:', e.message);
    }
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================

// --- INICIAR CAMPAÑA ---
app.post('/api/campaign', auth, async (req, res) => {
  try {
    const { clients, delaySeconds = 30 } = req.body;
    if (!clients?.length) return res.status(400).json({ error: 'No hay clientes' });

    const campaignId = crypto.randomUUID().slice(0, 8);
    const cls = clients.map(c => ({
      ...c,
      resultado: 'pendiente',
      logged: false,
      dtmf: null
    }));

    campaigns.set(campaignId, {
      clients: cls,
      started: new Date().toISOString(),
      completed: 0,
      total: cls.length,
      cancelled: false,
      delaySeconds
    });

    console.log(`\n🚀 Campaña ${campaignId} iniciada: ${cls.length} clientes, delay=${delaySeconds}s`);
    res.json({ campaignId, total: cls.length, status: 'iniciada' });

    // Ejecutar llamadas secuencialmente
    for (let i = 0; i < cls.length; i++) {
      const camp = campaigns.get(campaignId);
      if (!camp || camp.cancelled) {
        console.log(`⛔ Campaña ${campaignId} cancelada en llamada #${i}`);
        break;
      }

      try {
        await makeCall(cls[i].telefono, campaignId, i, cls[i]);
      } catch (err) {
        console.error(`❌ Error llamada ${i}:`, err.message);
        logResult(campaignId, i, null, 'error', cls[i]);
      }

      // Esperar entre llamadas (dar tiempo al IVR de completar)
      if (i < cls.length - 1) {
        await new Promise(r => setTimeout(r, delaySeconds * 1000));
      }
    }

    const camp = campaigns.get(campaignId);
    console.log(`\n✅ Campaña ${campaignId} completada: ${camp?.completed || 0}/${cls.length}`);
  } catch (err) {
    console.error('Campaign error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// --- STATUS CAMPAÑA ---
app.get('/api/campaign/:id', auth, (req, res) => {
  const camp = campaigns.get(req.params.id);
  if (!camp) return res.status(404).json({ error: 'No encontrada' });
  res.json({
    campaignId: req.params.id,
    total: camp.total,
    completed: camp.completed || 0,
    cancelled: !!camp.cancelled,
    started: camp.started,
    clients: camp.clients.map(c => ({
      nombre: c.nombre,
      telefono: c.telefono,
      saldo: c.saldo || '',
      resultado: c.resultado || 'pendiente',
      dtmf: c.dtmf || null
    }))
  });
});

// --- CANCELAR CAMPAÑA ---
app.post('/api/campaign/:id/cancel', auth, (req, res) => {
  const camp = campaigns.get(req.params.id);
  if (!camp) return res.status(404).json({ error: 'No encontrada' });
  camp.cancelled = true;
  console.log(`⛔ Campaña ${req.params.id} cancelada manualmente`);
  res.json({ status: 'cancelada' });
});

// --- LLAMADA DE PRUEBA ---
app.post('/api/test-call', auth, async (req, res) => {
  try {
    const { phone, nombre = 'Cliente Prueba', saldo = '1000' } = req.body;
    if (!phone) return res.status(400).json({ error: 'Falta phone' });

    console.log(`\n🧪 Llamada de prueba a ${nombre} (${phone})`);
    const result = await makeCall(phone, 'test', 0, {
      nombre, telefono: phone, saldo,
      diasAtraso: '30', promotor: 'Test', cobrador: 'Test'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- BALANCE ---
app.get('/api/balance', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/info/balance/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LISTAR ARCHIVOS IVR ---
app.get('/api/ivr-files', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/pbx/ivr/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LISTAR EXTENSIONES ---
app.get('/api/extensions', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/pbx/internal/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LISTAR ESCENARIOS IVR ---
app.get('/api/scenarios', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/pbx/ivr/scenario/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CONFIG ---
app.get('/api/config', auth, (req, res) => {
  res.json({
    version: '6.0',
    provider: 'zadarma',
    zadarma: {
      configured: !!(ZADARMA_API_KEY && ZADARMA_API_SECRET),
      sip: ZADARMA_SIP,
      callerId: ZADARMA_CALLER_ID,
      scenario: ZADARMA_SCENARIO,
      ivrFileId: IVR_FILE_ID || 'NO CONFIGURADO (usando TTS)'
    },
    gas: { configured: !!GAS_WEBHOOK_URL },
    whatsapp: WHATSAPP_NUMBER,
    serverUrl: SERVER_URL,
    webhookUrl: `${SERVER_URL}/zadarma`,
    activeCalls: activeCalls.size,
    phoneIndex: phoneToCall.size,
    activeCampaigns: campaigns.size
  });
});

// --- DEBUG CALL - probar diferentes params ---
app.get('/api/debug-call', auth, async (req, res) => {
  try {
    const phone = (req.query.phone || '5544621100').replace(/\D/g, '').slice(-10);
    
    // Probar manualmente con https nativo mostrando TODO
    const params = { from: '100', to: phone, sip: '100', predicted: 'predicted' };
    const method = '/v1/request/callback/';
    
    // Paso 1: Ordenar params
    const sortedKeys = Object.keys(params).sort();
    const pairs = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`);
    const paramsStr = pairs.join('&');
    
    // Paso 2: Firma
    const md5 = crypto.createHash('md5').update(paramsStr).digest('hex');
    const signData = method + paramsStr + md5;
    const sha1hex = crypto.createHmac('sha1', ZADARMA_API_SECRET).update(signData).digest('hex');
    const signature = Buffer.from(sha1hex).toString('base64');
    const authHeader = `${ZADARMA_API_KEY}:${signature}`;
    
    const debug = {
      params, paramsStr, md5, signData, sha1hex, signature, authHeader,
      sorted_keys: sortedKeys
    };
    
    // Test A: POST con body (nuestro método actual)
    const testA = await new Promise((resolve) => {
      const options = {
        hostname: 'api.zadarma.com',
        path: method,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(paramsStr)
        }
      };
      const r = https.request(options, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          try { resolve({ label: 'POST_body', statusCode: resp.statusCode, body: JSON.parse(body) }); }
          catch(e) { resolve({ label: 'POST_body', statusCode: resp.statusCode, raw: body }); }
        });
      });
      r.on('error', e => resolve({ label: 'POST_body', error: e.message }));
      r.write(paramsStr);
      r.end();
    });
    
    // Test B: GET con query string (misma firma)
    const testB = await new Promise((resolve) => {
      const options = {
        hostname: 'api.zadarma.com',
        path: `${method}?${paramsStr}`,
        method: 'GET',
        headers: {
          'Authorization': authHeader
        }
      };
      const r = https.request(options, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          try { resolve({ label: 'GET_query', statusCode: resp.statusCode, body: JSON.parse(body) }); }
          catch(e) { resolve({ label: 'GET_query', statusCode: resp.statusCode, raw: body }); }
        });
      });
      r.on('error', e => resolve({ label: 'GET_query', error: e.message }));
      r.end();
    });
    
    // Test C: POST con params en URL también (como hace axios por default)
    const testC = await new Promise((resolve) => {
      const options = {
        hostname: 'api.zadarma.com',
        path: method,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };
      const r = https.request(options, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          try { resolve({ label: 'POST_no_body', statusCode: resp.statusCode, body: JSON.parse(body) }); }
          catch(e) { resolve({ label: 'POST_no_body', statusCode: resp.statusCode, raw: body }); }
        });
      });
      r.on('error', e => resolve({ label: 'POST_no_body', error: e.message }));
      r.end();  // sin write - sin body
    });

    res.json({ debug, tests: [testA, testB, testC] });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// --- IVR SOUNDS ---
app.get('/api/ivr-sounds', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/pbx/ivr/sounds/list/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- IVR LIST ---
app.get('/api/ivr-list', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/pbx/ivr/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HEALTH ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '6.0',
    provider: 'zadarma',
    uptime: Math.floor(process.uptime()),
    activeCalls: activeCalls.size,
    campaigns: campaigns.size
  });
});

// --- DEBUG API AUTH ---
app.get('/api/debug-auth', auth, async (req, res) => {
  try {
    const keyInfo = {
      key_length: ZADARMA_API_KEY.length,
      key_preview: ZADARMA_API_KEY.substring(0, 6) + '...' + ZADARMA_API_KEY.slice(-4),
      secret_length: ZADARMA_API_SECRET.length,
      secret_preview: ZADARMA_API_SECRET.substring(0, 6) + '...' + ZADARMA_API_SECRET.slice(-4),
      key_has_spaces: ZADARMA_API_KEY !== ZADARMA_API_KEY.trim(),
      secret_has_spaces: ZADARMA_API_SECRET !== ZADARMA_API_SECRET.trim(),
      key_has_newline: ZADARMA_API_KEY.includes('\n') || ZADARMA_API_KEY.includes('\r'),
      secret_has_newline: ZADARMA_API_SECRET.includes('\n') || ZADARMA_API_SECRET.includes('\r'),
      key_charCodes: [...ZADARMA_API_KEY].map(c => c.charCodeAt(0)),
      secret_charCodes: [...ZADARMA_API_SECRET].map(c => c.charCodeAt(0)),
    };

    // Mostrar cálculo de firma paso a paso
    const method = '/v1/info/balance/';
    const paramsStr = '';
    const md5 = crypto.createHash('md5').update(paramsStr).digest('hex');
    const signData = method + paramsStr + md5;
    const signature = Buffer.from(crypto.createHmac('sha1', ZADARMA_API_SECRET).update(signData).digest('hex')).toString('base64');

    const signatureDebug = {
      method,
      paramsStr,
      md5_of_params: md5,
      sign_data: signData,
      signature,
      auth_header: ZADARMA_API_KEY + ':' + signature
    };

    // Test con las keys limpias (trim)
    const cleanKey = ZADARMA_API_KEY.trim().replace(/[^\x20-\x7E]/g, '');
    const cleanSecret = ZADARMA_API_SECRET.trim().replace(/[^\x20-\x7E]/g, '');
    const cleanSig = Buffer.from(crypto.createHmac('sha1', cleanSecret).update(signData).digest('hex')).toString('base64');

    const cleanTest = {
      key_cleaned: cleanKey !== ZADARMA_API_KEY,
      secret_cleaned: cleanSecret !== ZADARMA_API_SECRET,
      clean_key_length: cleanKey.length,
      clean_secret_length: cleanSecret.length,
    };

    // Método buggy del npm (hex string → base64)
    const sha1hex = crypto.createHmac('sha1', cleanSecret).update(signData).digest('hex');
    const buggySig = Buffer.from(sha1hex).toString('base64');

    // Helper para probar una firma
    function testAuth(label, authHeader) {
      return new Promise((resolve) => {
        const options = {
          hostname: 'api.zadarma.com',
          path: '/v1/info/balance/',
          method: 'GET',
          headers: { 'Authorization': authHeader }
        };
        const req = https.request(options, (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => {
            try { resolve({ label, statusCode: r.statusCode, headers: r.headers, body: JSON.parse(body) }); }
            catch(e) { resolve({ label, statusCode: r.statusCode, raw: body }); }
          });
        });
        req.on('error', e => resolve({ label, error: e.message }));
        req.end();
      });
    }

    // Probar 3 métodos
    const [test1, test2, test3] = await Promise.all([
      testAuth('correct_base64', cleanKey + ':' + cleanSig),
      testAuth('buggy_npm_hex2base64', cleanKey + ':' + buggySig),
      testAuth('no_trailing_slash', cleanKey + ':' + crypto.createHmac('sha1', cleanSecret).update('/v1/info/balanced41d8cd98f00b204e9800998ecf8427e').digest('base64'))
    ]);

    res.json({ keyInfo, signatureDebug, cleanTest, tests: { test1, test2, test3 } });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// --- ROOT ---
app.get('/', (req, res) => {
  res.json({
    service: 'LeGaXi IVR v6.0 - Zadarma Webhook IVR',
    status: 'running',
    endpoints: {
      webhook: '/zadarma',
      panel: '/panel',
      testCall: 'POST /api/test-call',
      campaign: 'POST /api/campaign',
      balance: 'GET /api/balance',
      config: 'GET /api/config',
      ivrFiles: 'GET /api/ivr-files',
      scenarios: 'GET /api/scenarios',
      extensions: 'GET /api/extensions'
    }
  });
});

// --- PANEL HTML ---
const panelPath = path.join(__dirname, 'panel.html');
if (fs.existsSync(panelPath)) {
  app.get('/panel', (req, res) => res.sendFile(panelPath));
}

// ============================================================
// LIMPIEZA PERIÓDICA
// ============================================================
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutos

  for (const [key, call] of phoneToCall) {
    if (now - call.startTime > timeout) {
      if (!call.logged) {
        logResult(call.campaignId, call.index, 'timeout', 'sin_respuesta', call);
      }
      phoneToCall.delete(key);
    }
  }

  for (const [key, call] of activeCalls) {
    if (now - call.startTime > timeout) {
      activeCalls.delete(key);
    }
  }

  // Limpiar campañas viejas (>1 hora)
  for (const [key, camp] of campaigns) {
    if (now - new Date(camp.started).getTime() > 3600000) {
      campaigns.delete(key);
    }
  }
}, 60000);

// ============================================================
// REGISTRAR WEBHOOK EN ZADARMA (vía API)
// ============================================================
async function registerWebhook() {
  if (!ZADARMA_API_KEY || !ZADARMA_API_SECRET) {
    console.log('⚠️ No se puede registrar webhook: faltan API keys');
    return;
  }

  const webhookUrl = `${SERVER_URL}/zadarma`;
  console.log(`\n🔗 Registrando webhook URL: ${webhookUrl}`);

  try {
    // Registrar URL de notificaciones de llamadas PBX
    const result = await zadarmaRequest('/v1/pbx/callinfo/url/', { url: webhookUrl });
    console.log(`   Callinfo URL: ${JSON.stringify(result)}`);

    // Habilitar todas las notificaciones
    const hooks = await zadarmaRequest('/v1/pbx/callinfo/notifications/', {
      call_start: 'true',
      call_end: 'true',
      ivr: 'true',
      out_start: 'true',
      out_end: 'true'
    });
    console.log(`   Notificaciones: ${JSON.stringify(hooks)}`);

    // Verificar configuración actual
    const current = await zadarmaRequest('/v1/pbx/callinfo/');
    console.log(`   Config actual: ${JSON.stringify(current)}`);

    console.log('✅ Webhook registrado exitosamente');
  } catch (err) {
    console.error('❌ Error registrando webhook:', err.message);
    console.log('   Intenta registrar manualmente en: my.zadarma.com/marketplace/#tab-apiWebhooks');
  }
}

// Endpoint manual para registrar webhook
app.post('/api/register-webhook', auth, async (req, res) => {
  try {
    const webhookUrl = `${SERVER_URL}/zadarma`;

    const result1 = await zadarmaRequest('/v1/pbx/callinfo/url/', { url: webhookUrl });
    const result2 = await zadarmaRequest('/v1/pbx/callinfo/notifications/', {
      call_start: 'true',
      call_end: 'true',
      ivr: 'true',
      out_start: 'true',
      out_end: 'true'
    });

    res.json({
      success: true,
      webhookUrl,
      callinfo: result1,
      notifications: result2
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint para ver webhook actual
app.get('/api/webhook-status', auth, async (req, res) => {
  try {
    const result = await zadarmaRequest('/v1/pbx/callinfo/');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   🚀 LeGaXi IVR v6.0 - ZADARMA WEBHOOK IVR        ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║ Puerto:     ${PORT}`);
  console.log(`║ Extensión:  ${ZADARMA_SIP}`);
  console.log(`║ CallerID:   ${ZADARMA_CALLER_ID}`);
  console.log(`║ Escenario:  ${ZADARMA_SCENARIO}`);
  console.log(`║ IVR File:   ${IVR_FILE_ID || 'TTS dinámico'}`);
  console.log(`║ Webhook:    ${SERVER_URL}/zadarma`);
  console.log(`║ GAS:        ${GAS_WEBHOOK_URL ? '✅ Configurado' : '❌ No configurado'}`);
  console.log(`║ API Key:    ${API_KEY ? '✅ Protegido' : '⚠️ Sin protección'}`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Auto-registrar webhook al arrancar (con delay para que el server esté listo)
  setTimeout(registerWebhook, 3000);
});
