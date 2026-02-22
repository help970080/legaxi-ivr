// ============================================
// Google Apps Script - LeGaXi IVR Webhook
// Agrega esto como nueva función en tu GAS existente
// ============================================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    
    if (data.action === 'registrarLlamadaIVR') {
      return registrarLlamadaIVR(data);
    }
    
    // ... tus otras funciones existentes
    return ContentService.createTextOutput(JSON.stringify({status: 'ok'}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function registrarLlamadaIVR(data) {
  var ss = SpreadsheetApp.openById('19Zmr5iti-cUH6FQO951_P8TxJv-1DpgqE6OMNNt9sfc');
  var sheet = ss.getSheetByName('IVR_Resultados');
  
  if (!sheet) {
    sheet = ss.insertSheet('IVR_Resultados');
    sheet.appendRow(['Fecha', 'Nombre', 'Teléfono', 'Saldo', 'Días Atraso', 'Promotor', 'Resultado', 'Detalle', 'Campaign ID']);
    sheet.getRange(1, 1, 1, 9).setBackground('#f59e0b').setFontColor('#000').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  
  var row = [
    new Date(),
    data.nombre || '',
    data.telefono || '',
    data.saldo || '',
    data.diasAtraso || '',
    data.promotor || '',
    data.resultado || '',
    data.detalle || '',
    data.campaignId || ''
  ];
  
  var lastRow = sheet.getLastRow() + 1;
  sheet.appendRow(row);
  
  // Color por resultado
  var colors = {
    'promesa_pago': '#dcfce7',
    'ya_pago': '#e9d5ff',
    'transferencia': '#dbeafe',
    'no_contesto': '#fef3c7',
    'ocupado': '#fef3c7',
    'error': '#fecaca'
  };
  var bg = colors[data.resultado] || '#f1f5f9';
  sheet.getRange(lastRow, 1, 1, 9).setBackground(bg);
  
  return ContentService.createTextOutput(JSON.stringify({status: 'ok', row: lastRow}))
    .setMimeType(ContentService.MimeType.JSON);
}
