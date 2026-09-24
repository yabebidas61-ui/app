// =========================================================================
// NEXUS — INTEGRACIÓN WHATSAPP (whatsapp-web.js)
// =========================================================================
// Conecta el negocio a WhatsApp para:
//   1) Responder preguntas por texto (ventas, caja, deudas, riesgo)
//   2) Enviar un reporte automático programado todos los días
//
// IMPORTANTE — LEE ESTO ANTES DE DESPLEGAR EN RENDER:
//   - whatsapp-web.js necesita guardar una sesión en disco (carpeta
//     WHATSAPP_SESSION_PATH) para no pedirte escanear el QR cada vez.
//     En Render, eso requiere un "Persistent Disk" (plan de pago) montado
//     en esa ruta. En el plan gratuito la sesión se borra y el servicio
//     se duerme por inactividad, así que se desconectará solo.
//   - Solo los números listados en WHATSAPP_DESTINATARIOS pueden hacer
//     preguntas y recibir reportes. Cualquier otro número que escriba
//     recibe un mensaje de "no autorizado" y no ve datos del negocio.
// =========================================================================

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron   = require('node-cron');

let db = null;              // instancia de Firestore, inyectada desde server.js
let client = null;
let ultimoQR = null;        // guarda el último QR generado, para mostrarlo por navegador
let listo = false;

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || '.wwebjs_auth';

// Números autorizados a consultar/recibir reportes.
// Formato en .env: WHATSAPP_DESTINATARIOS=593987654321,593912345678
const DESTINATARIOS = (process.env.WHATSAPP_DESTINATARIOS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean)
  .map(n => `${n}@c.us`);

function estaAutorizado(numeroWid) {
  return DESTINATARIOS.includes(numeroWid);
}

function normalizarTexto(txt) {
  return (txt || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .trim();
}

// =========================================================================
// HELPERS DE FECHA (zona horaria Guayaquil, igual que el resto de NEXUS)
// =========================================================================
function fechaHoyGuayaquil() {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  const d = String(ahora.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function rangoDiaISO(fechaYMD) {
  return {
    inicio: new Date(fechaYMD + 'T00:00:00.000Z').toISOString(),
    fin:    new Date(fechaYMD + 'T23:59:59.999Z').toISOString()
  };
}

// =========================================================================
// CONSTRUCCIÓN DE REPORTES (leen de Firestore usando las mismas colecciones
// que ya usa el resto de NEXUS)
// =========================================================================

async function reporteVentasHoy() {
  const fecha = fechaHoyGuayaquil();
  const { inicio, fin } = rangoDiaISO(fecha);

  const snap = await db.collection('ventas')
    .where('fecha', '>=', inicio)
    .where('fecha', '<=', fin)
    .get();

  let total = 0, efectivo = 0, transferencia = 0, credito = 0, count = 0;
  snap.forEach(doc => {
    const v = doc.data();
    const t = Number(v.total || 0);
    total += t;
    count++;
    if (v.tipo === 'efectivo') efectivo += t;
    else if (v.tipo === 'transferencia') transferencia += t;
    else if (v.tipo === 'credito') credito += t;
  });

  return (
    `🧾 *Ventas de hoy (${fecha})*\n` +
    `Total: $${total.toFixed(2)} (${count} venta${count === 1 ? '' : 's'})\n` +
    `• Efectivo: $${efectivo.toFixed(2)}\n` +
    `• Transferencia: $${transferencia.toFixed(2)}\n` +
    `• Crédito: $${credito.toFixed(2)}`
  );
}

async function reporteCaja() {
  const snap = await db.collection('cajas').where('activa', '==', true).get();
  if (snap.empty) return '📭 No hay ninguna caja abierta en este momento.';

  const caja  = snap.docs[0].data();
  const saldo = Number(caja.apertura || 0) + Number(caja.ingresos || 0) - Number(caja.gastos || 0);

  return (
    `💵 *Estado de caja*\n` +
    `Apertura: $${Number(caja.apertura || 0).toFixed(2)}\n` +
    `Ingresos: $${Number(caja.ingresos || 0).toFixed(2)}\n` +
    `Gastos: $${Number(caja.gastos || 0).toFixed(2)}\n` +
    `Saldo actual: $${saldo.toFixed(2)}`
  );
}

async function reporteDeudas() {
  const snap = await db.collection('deudas').get();

  let totalCredito = 0, totalAbonado = 0;
  const pendientesPorCliente = {};

  snap.forEach(doc => {
    const d = doc.data();
    const total  = Number(d.total  || 0);
    const pagado = Number(d.pagado || 0);
    totalCredito += total;
    totalAbonado += pagado;
    const pendiente = total - pagado;
    if (pendiente > 0.01) {
      pendientesPorCliente[d.cliente || 'Sin nombre'] =
        (pendientesPorCliente[d.cliente || 'Sin nombre'] || 0) + pendiente;
    }
  });

  const totalPendiente = totalCredito - totalAbonado;
  const topDeudores = Object.entries(pendientesPorCliente)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  let texto =
    `📋 *Cuentas por cobrar*\n` +
    `Pendiente total: $${totalPendiente.toFixed(2)}\n` +
    `Clientes con deuda: ${Object.keys(pendientesPorCliente).length}\n`;

  if (topDeudores.length) {
    texto += `\nMayores deudores:\n`;
    topDeudores.forEach(([nombre, monto], i) => {
      texto += `${i + 1}. ${nombre}: $${monto.toFixed(2)}\n`;
    });
  }

  return texto.trim();
}

async function reporteRiesgo() {
  const deudasSnap = await db.collection('deudas').get();
  let totalCredito = 0, totalAbonado = 0;
  deudasSnap.forEach(doc => {
    const d = doc.data();
    totalCredito += Number(d.total || 0);
    totalAbonado += Number(d.pagado || 0);
  });
  const totalPendiente = totalCredito - totalAbonado;
  const pctRecuperacion = totalCredito > 0 ? (totalAbonado / totalCredito) * 100 : 0;

  return (
    `📊 *Resumen de riesgo crediticio*\n` +
    `Crédito histórico otorgado: $${totalCredito.toFixed(2)}\n` +
    `Recuperado: $${totalAbonado.toFixed(2)} (${pctRecuperacion.toFixed(1)}%)\n` +
    `Pendiente: $${totalPendiente.toFixed(2)}`
  );
}

async function reporteDiarioCompleto() {
  const [ventas, caja, deudas] = await Promise.all([
    reporteVentasHoy(),
    reporteCaja(),
    reporteDeudas()
  ]);
  return `📅 *Reporte diario del negocio*\n\n${ventas}\n\n${caja}\n\n${deudas}`;
}

const MENSAJE_AYUDA =
  `👋 *NEXUS Bot* — comandos disponibles:\n\n` +
  `*ventas* — ventas de hoy\n` +
  `*caja* — estado actual de caja\n` +
  `*deudas* — cuentas por cobrar\n` +
  `*riesgo* — resumen de riesgo crediticio\n` +
  `*reporte* — reporte diario completo\n` +
  `*ayuda* — ver este mensaje`;

// =========================================================================
// MANEJO DE MENSAJES ENTRANTES
// =========================================================================
async function manejarMensaje(message) {
  if (message.from === 'status@broadcast') return;

  if (!estaAutorizado(message.from)) {
    // No respondemos con datos ni pistas a números no autorizados.
    await message.reply('🔒 Este número no está autorizado para consultar el negocio.');
    return;
  }

  const texto = normalizarTexto(message.body);

  try {
    if (['ayuda', 'menu', 'hola', 'help'].includes(texto)) {
      await message.reply(MENSAJE_AYUDA);
    } else if (texto.startsWith('venta')) {
      await message.reply(await reporteVentasHoy());
    } else if (texto.startsWith('caja')) {
      await message.reply(await reporteCaja());
    } else if (texto.startsWith('deuda')) {
      await message.reply(await reporteDeudas());
    } else if (texto.startsWith('riesgo')) {
      await message.reply(await reporteRiesgo());
    } else if (texto.startsWith('reporte')) {
      await message.reply(await reporteDiarioCompleto());
    } else {
      await message.reply(`No reconocí ese comando.\n\n${MENSAJE_AYUDA}`);
    }
  } catch (err) {
    console.error('❌ Error respondiendo por WhatsApp:', err.message);
    await message.reply('⚠️ Ocurrió un error al generar ese reporte. Intenta de nuevo en un momento.');
  }
}

// =========================================================================
// REPORTE PROGRAMADO (cron)
// =========================================================================
function programarReporteDiario() {
  // Formato HH:mm, 24 horas, zona America/Guayaquil. Por defecto 20:00.
  const hora = process.env.WHATSAPP_HORA_REPORTE || '20:00';
  const [h, m] = hora.split(':').map(Number);

  if (isNaN(h) || isNaN(m)) {
    console.warn('⚠️ WHATSAPP_HORA_REPORTE inválida, usando 20:00 por defecto.');
  }

  const cronExpr = `${isNaN(m) ? 0 : m} ${isNaN(h) ? 20 : h} * * *`;

  cron.schedule(cronExpr, async () => {
    if (!listo || DESTINATARIOS.length === 0) return;
    try {
      const texto = await reporteDiarioCompleto();
      for (const wid of DESTINATARIOS) {
        await client.sendMessage(wid, texto);
      }
      console.log('📤 Reporte diario de WhatsApp enviado.');
    } catch (err) {
      console.error('❌ Error enviando reporte diario por WhatsApp:', err.message);
    }
  }, { timezone: 'America/Guayaquil' });

  console.log(`⏰ Reporte diario de WhatsApp programado a las ${hora} (America/Guayaquil).`);
}

// =========================================================================
// INICIALIZACIÓN
// =========================================================================
function iniciarWhatsApp(appExpress, dbInstancia) {
  db = dbInstancia;

  if (DESTINATARIOS.length === 0) {
    console.warn('⚠️ WHATSAPP_DESTINATARIOS no configurado: nadie podrá consultar ni recibir reportes.');
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  client.on('qr', (qr) => {
    ultimoQR = qr;
    listo = false;
    console.log('📱 Escanea el QR de WhatsApp: abre /whatsapp/qr en el navegador, o mira el QR en texto abajo.');
    qrcode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
      if (!err) console.log(url);
    });
  });

  client.on('ready', () => {
    listo = true;
    ultimoQR = null;
    console.log('✅ WhatsApp conectado y listo para NEXUS.');
  });

  client.on('disconnected', (reason) => {
    listo = false;
    console.warn('⚠️ WhatsApp se desconectó:', reason);
  });

  client.on('message', (message) => {
    manejarMensaje(message).catch(err => console.error('❌ Error en manejarMensaje:', err.message));
  });

  client.initialize();
  programarReporteDiario();

  // ---- Endpoints para administrar la conexión desde el navegador ----

  // Muestra el QR como imagen para escanearlo cómodamente desde el celular.
  appExpress.get('/whatsapp/qr', async (req, res) => {
    if (listo) {
      return res.send('<h2>✅ WhatsApp ya está conectado.</h2>');
    }
    if (!ultimoQR) {
      return res.send('<h2>⏳ Generando QR, recarga esta página en unos segundos...</h2>');
    }
    try {
      const dataUrl = await qrcode.toDataURL(ultimoQR);
      res.send(`
        <html><body style="text-align:center;font-family:sans-serif;">
          <h2>Escanea este código con WhatsApp (WhatsApp > Dispositivos vinculados)</h2>
          <img src="${dataUrl}" style="width:300px;height:300px;" />
          <p>Esta página se actualiza sola cada 10 segundos.</p>
          <script>setTimeout(() => location.reload(), 10000);</script>
        </body></html>
      `);
    } catch (err) {
      res.status(500).send('Error generando el QR: ' + err.message);
    }
  });

  appExpress.get('/whatsapp/estado', (req, res) => {
    res.json({ conectado: listo, destinatariosConfigurados: DESTINATARIOS.length });
  });
}

module.exports = { iniciarWhatsApp };
