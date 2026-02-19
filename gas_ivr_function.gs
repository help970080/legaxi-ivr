// ============================================================
// AGREGAR ESTA FUNCIÓN A TU Google Apps Script EXISTENTE
// (gas_backend_corregido.gs)
// ============================================================

// Registrar resultado de llamada IVR
function registrarLlamadaIVR(e) {
  try {
    var ss = SpreadsheetApp.openById('19Zmr5iti-cUH6FQO951_P8TxJv-1DpgqE6OMNNt9sfc');
    
    // Crear hoja si no existe
    var sheet = ss.getSheetByName('LlamadasIVR');
    if (!sheet) {
      sheet = ss.insertSheet('LlamadasIVR');
      sheet.appendRow([
        'Fecha', 'Nombre', 'Teléfono', 'Saldo', 'Días Atraso', 
        'Promotor', 'Resultado', 'Detalle', 'Cobrador', 'Campaign ID'
      ]);
      // Formato encabezado
      sheet.getRange(1, 1, 1, 10).setBackground('#1F4E79').setFontColor('white').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    
    var params = e.parameter || e;
    
    // Formatear fecha
    var fecha = params.fecha ? new Date(params.fecha) : new Date();
    var fechaStr = Utilities.formatDate(fecha, 'America/Mexico_City', 'dd/MM/yyyy HH:mm:ss');
    
    // Agregar fila
    sheet.appendRow([
      fechaStr,
      params.nombre || '',
      params.telefono || '',
      Number(params.saldo) || 0,
      Number(params.diasAtraso) || 0,
      params.promotor || '',
      params.resultado || '',
      params.detalle || '',
      params.cobrador || '',
      params.campaignId || ''
    ]);
    
    // Color según resultado
    var lastRow = sheet.getLastRow();
    var resultCell = sheet.getRange(lastRow, 7);
    var resultado = String(params.resultado || '');
    
    if (resultado === 'promesa_pago') {
      resultCell.setBackground('#d4edda').setFontColor('#155724');
    } else if (resultado === 'ya_pago') {
      resultCell.setBackground('#cce5ff').setFontColor('#004085');
    } else if (resultado === 'transferencia') {
      resultCell.setBackground('#fff3cd').setFontColor('#856404');
    } else if (resultado === 'no_contesto' || resultado === 'ocupado') {
      resultCell.setBackground('#f8d7da').setFontColor('#721c24');
    }
    
    return ContentService.createTextOutput(
      JSON.stringify({ success: true, row: lastRow })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: err.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// MODIFICAR tu función doGet existente para manejar la nueva acción
// Agregar este case dentro de tu switch/if de acciones:
// ============================================================
// 
// En tu doGet(e):
//   if (action === 'registrarLlamadaIVR') return registrarLlamadaIVR(e);
//
