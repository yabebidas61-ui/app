require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// =========================================================================
// 1. CONFIGURACIÓN DE FIREBASE ADMIN SDK
// =========================================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ ERROR CRÍTICO: La variable de entorno FIREBASE_SERVICE_ACCOUNT no está configurada.");
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ ¡Conectado exitosamente a Firebase Cloud Firestore!");
} catch (error) {
  console.error("❌ Error crítico al procesar FIREBASE_SERVICE_ACCOUNT:", error.message);
  process.exit(1);
}

const db = admin.firestore();

// =========================================================================
// 2. CONFIGURACIÓN DE BREVO (API HTTP)
// =========================================================================
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'ad85ef001@smtp-brevo.com';

if (BREVO_API_KEY) {
  console.log("📧 Brevo API (HTTP) configurada. Listo para enviar correos.");
  iniciarGuardianCaducidades();
} else {
  console.warn("⚠️ BREVO_API_KEY no configurado en Render. Envío de correos inhabilitado.");
}

async function enviarCorreoBrevo({ to, subject, html, fromName, fromEmail }) {
  if (!BREVO_API_KEY) return { ok: false, error: "BREVO_API_KEY no configurado" };

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: { name: fromName || "Agro Naranjito #1", email: fromEmail || BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });

    const data = await resp.json();
    if (resp.ok) return { ok: true, data };
    console.error("❌ Brevo API rechazó el envío:", JSON.stringify(data));
    return { ok: false, error: data.message || "Error en Brevo API", data };
  } catch (err) {
    console.error("❌ Error al conectar con Brevo API:", err.message);
    return { ok: false, error: err.message };
  }
}

// =========================================================================
// 3. INVOKA — FACTURACIÓN ELECTRÓNICA SRI
// =========================================================================

app.post('/sri/configurar', async (req, res) => {
  if (!process.env.INVOKA_API_KEY) {
    return res.status(500).json({ error: "INVOKA_API_KEY no configurada en Render" });
  }
  try {
    const response = await fetch("https://www.invoka.com.ec/api/empresa/crear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.INVOKA_API_KEY
      },
      body: JSON.stringify({
        ruc:               process.env.INVOKA_RUC,
        razon_social:      process.env.INVOKA_RAZON_SOCIAL,
        grancontribuyente: false,
        smtp:              true,
        smtp_host:         "smtp-relay.brevo.com",
        smtp_port:         465,
        smtp_user:         "ad85ef001@smtp-brevo.com",
        smtp_password:     process.env.BREVO_SMTP_KEY,
        smtp_encryption:   "ssl",
        smtp_from_email:   "ad85ef001@smtp-brevo.com"
      })
    });
    const data = await response.json();
    console.log("📋 Respuesta Invoka /empresa/crear:", JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error("❌ Error al registrar empresa en Invoka:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/sri/firma', async (req, res) => {
  if (!process.env.INVOKA_API_KEY) {
    return res.status(500).json({ error: "INVOKA_API_KEY no configurada en Render" });
  }

  const { firma_base64, password } = req.body;

  if (!firma_base64 || !password) {
    return res.status(400).json({ error: "Se requiere firma_base64 y password" });
  }

  try {
    const response = await fetch("https://www.invoka.com.ec/api/empresa/subirfirma", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.INVOKA_API_KEY
      },
      body: JSON.stringify({
        firma_base64,
        password,
        ruc: process.env.INVOKA_RUC
      })
    });

    const rawText = await response.text();
    console.log("📋 Invoka /empresa/subirfirma status:", response.status);
    console.log("📋 Invoka /empresa/subirfirma response:", rawText.slice(0, 300));

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        error: `Invoka devolvió respuesta no JSON (status ${response.status})`,
        raw: rawText.slice(0, 200)
      });
    }

    if (response.ok) {
      console.log("✅ Firma electrónica registrada en Invoka exitosamente");
      res.json({ ok: true, mensaje: "Firma registrada correctamente en Invoka", data });
    } else {
      console.warn("⚠️ Invoka rechazó la firma:", JSON.stringify(data));
      res.status(response.status).json({ ok: false, error: data.mensaje || data.error || "Error en Invoka", data });
    }
  } catch (err) {
    console.error("❌ Error al subir firma a Invoka:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/sri/estado', async (req, res) => {
  if (!process.env.INVOKA_API_KEY) {
    return res.status(500).json({ error: "INVOKA_API_KEY no configurada" });
  }
  try {
    const response = await fetch(`https://www.invoka.com.ec/api/empresa/${process.env.INVOKA_RUC}`, {
      headers: { "X-API-KEY": process.env.INVOKA_API_KEY }
    });
    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); } catch (e) { data = { raw: rawText.slice(0, 200) }; }
    res.json({ status: response.status, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function obtenerSiguienteSecuencial() {
  const ref = db.collection('config').doc('secuencialFactura');
  const doc = await ref.get();
  let actual = doc.exists ? (doc.data().valor || 0) : 0;
  actual += 1;
  await ref.set({ valor: actual });
  return String(actual).padStart(9, '0');
}

async function emitirFacturaInvoka({ cliente, cedula, correo, carrito, descuento = 0, total }) {
  if (!process.env.INVOKA_API_KEY) {
    console.warn("⚠️ INVOKA_API_KEY no configurada. Factura electrónica omitida.");
    return { ok: false, error: "API Key de Invoka no configurada" };
  }

  const esConsumidorFinal  = !cedula || cedula === "9999999999999" || cedula === "SIN CÉDULA";
  const tipoIdentificacion = esConsumidorFinal ? "07" : (String(cedula).length === 13 ? "04" : "05");
  const identificacion     = esConsumidorFinal ? "9999999999999" : String(cedula);

  const hoy = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Guayaquil" }));
  const fechaEmision = `${hoy.getFullYear()}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${String(hoy.getDate()).padStart(2, '0')}`;
  const secuencial = await obtenerSiguienteSecuencial();

  let subtotal15Acumulado = 0;

  const items = (carrito || []).map((p, i) => {
    const cantidad = Number(p.amount || p.cantidad || 1);
    const precio   = Number(p.precio || 0);
    const subtotalItem = precio * cantidad;

    subtotal15Acumulado += subtotalItem;

    return {
      codigo_principal:          p.codigo || `PROD-${i + 1}`,
      descripcion:               p.nombre || "Producto",
      cantidad,
      precio_unitario:           precio,
      descuento:                 0,
      precio_total_sin_impuesto: Number(subtotalItem.toFixed(2)),
      tipoproducto:              1,
      tipo_iva:                  4
    };
  });

  const subtotalConIva15 = Number(subtotal15Acumulado.toFixed(2));
  const totalDescuento   = Number(Number(descuento).toFixed(2));
  const baseImponible    = Math.max(0, subtotalConIva15 - totalDescuento);
  const valorIva         = Number((baseImponible * 0.15).toFixed(2));
  const totalAPagar      = Number((baseImponible + valorIva).toFixed(2));

  const facturaData = {
    ambiente: Number(process.env.INVOKA_AMBIENTE || 1),
    emisor: {
      nombre_comercial:           process.env.INVOKA_NOMBRE_COMERCIAL || process.env.INVOKA_RAZON_SOCIAL || "AGRO NARANJITO #1",
      razon_social:                process.env.INVOKA_RAZON_SOCIAL || "AGRO NARANJITO #1",
      ruc:                          process.env.INVOKA_RUC,
      codigo_establecimiento:       process.env.INVOKA_COD_ESTABLECIMIENTO || "001",
      codigo_puntoemision:          process.env.INVOKA_COD_PUNTOEMISION   || "001",
      direccion_matriz:             process.env.INVOKA_DIRECCION || "ECUADOR",
      direccion_establecimiento:    process.env.INVOKA_DIRECCION || "ECUADOR",
      obligado_contabilidad:        process.env.INVOKA_OBLIGADO_CONTABILIDAD || "NO",
      fecha_emision:                fechaEmision,
      secuencial:                   secuencial
    },
    comprador: {
      identificacion,
      tipo_identificacion: tipoIdentificacion,
      razon_social:        cliente || "CONSUMIDOR FINAL",
      direccion:           "ECUADOR",
      ...(correo ? { correo } : {})
    },
    items,
    subtotal: subtotalConIva15,
    discount: totalDescuento,
    iva: valorIva,
    total: totalAPagar,
    formas_pago: [
      {
        forma_pago: "20",
        total: totalAPagar
      }
    ]
  };

  try {
    console.log("📤 Enviando a Invoka:", JSON.stringify(facturaData, null, 2));
    const resp = await fetch("https://www.invoka.com.ec/api/factura/emision", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "X-API-KEY":     process.env.INVOKA_API_KEY
      },
      body: JSON.stringify(facturaData)
    });

    const rawText = await resp.text();
    console.log("📋 Invoka /factura/emision status:", resp.status);
    console.log("📋 Invoka /factura/emision response:", rawText.slice(0, 500));

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error("❌ Invoka no devolvió JSON válido");
      return { ok: false, error: `Invoka devolvió HTML (status ${resp.status}), no JSON` };
    }

    if (data.creado) {
      console.log(`✅ Factura SRI registrada — Clave: ${data.claveacceso}`);
      return { ok: true, claveAcceso: data.claveacceso, autorizacion: data.id_comprobante, data };
    } else {
      console.warn("⚠️ Invoka respondió sin crear factura:", JSON.stringify(data));
      return { ok: false, error: data.mensaje || JSON.stringify(data.errors) || "Respuesta inesperada de Invoka", data };
    }
  } catch (err) {
    console.error("❌ Error al conectar con Invoka:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Helper: Generación dinámica del cuerpo HTML del comprobante ───────────
function generarHTMLCorreo(datos, carrito, tipoPago) {
  const {
    cliente, cedula, subtotal, pct, descuentoMonto, totalFinal,
    tasaPct, montoInteres, meses, pago, vuelto,
    bancoNombre, bancoCuenta, comprobante,
    claveAccesoSRI
  } = datos;

  const fecha = new Date().toLocaleString("es-EC", { dateStyle: "long", timeStyle: "short" });

  const filas = (carrito || []).map(p => `
    <tr>
      <td style="padding:8px 10px; border-bottom:1px solid #f0f0f0; text-align:left;">${p.nombre}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #f0f0f0; text-align:center;">${p.amount || p.cantidad}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #f0f0f0; text-align:right;">$${Number(p.precio).toFixed(2)}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #f0f0f0; text-align:right; font-weight:bold;">$${(Number(p.precio) * Number(p.amount || p.cantidad)).toFixed(2)}</td>
    </tr>
  `).join("");

  let detallePago = "";
  if (tipoPago === "efectivo") {
    detallePago = `
      <tr><td style="padding:4px 0; color:#555;">Monto Recibido</td><td style="text-align:right; font-weight:500;">$${Number(pago).toFixed(2)}</td></tr>
      <tr><td style="padding:4px 0; color:#555;">Vuelto Entregado</td><td style="text-align:right; font-weight:500;">$${Number(vuelto).toFixed(2)}</td></tr>
    `;
  } else if (tipoPago === "transferencia") {
    detallePago = `
      <tr><td style="padding:4px 0; color:#555;">Entidad Bancaria</td><td style="text-align:right; font-weight:500;">${bancoNombre}</td></tr>
      <tr><td style="padding:4px 0; color:#555;">Nº de Cuenta</td><td style="text-align:right; font-family:monospace;">${bancoCuenta}</td></tr>
      <tr><td style="padding:4px 0; color:#555;">Nº Referencia / Código</td><td style="text-align:right; font-weight:bold; color:#1e272e;">${comprobante}</td></tr>
    `;
  } else if (tipoPago === "credito") {
    detallePago = `
      <tr><td style="padding:4px 0; color:#555;">Tasa Diferido (${tasaPct}%)</td><td style="text-align:right; color:#e67e22;">+$${Number(montoInteres).toFixed(2)}</td></tr>
      <tr><td style="padding:4px 0; color:#555;">Plazo Acordado</td><td style="text-align:right; font-weight:500;">${meses} meses</td></tr>
    `;
  }

  const descuentoRow = Number(pct) > 0 ? `
    <tr>
      <td style="padding:4px 0; color:#555;">Subtotal Bruto</td>
      <td style="text-align:right;">$${Number(subtotal).toFixed(2)}</td>
    </tr>
    <tr>
      <td style="padding:4px 0; color:#e03329;">Descuento Aplicado (${pct}%)</td>
      <td style="text-align:right; color:#e03329; font-weight:500;">-$${Number(descuentoMonto).toFixed(2)}</td>
    </tr>
  ` : "";

  const sriBadge = claveAccesoSRI ? `
    <tr>
      <td colspan="2" style="padding:8px 0;">
        <div style="background:#eafaf1; border:1px solid #27ae60; border-radius:6px; padding:8px 12px; text-align:center;">
          <p style="margin:0; font-size:11px; color:#27ae60; font-weight:700;">✅ FACTURA ELECTRÓNICA AUTORIZADA — SRI</p>
          <p style="margin:4px 0 0; font-size:10px; color:#555; font-family:monospace; word-break:break-all;">${claveAccesoSRI}</p>
        </div>
      </td>
    </tr>
  ` : "";

  const tipoBadgeColor = tipoPago === "efectivo" ? "#27ae60" : tipoPago === "transferencia" ? "#2980b9" : "#e67e22";

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0; padding:0; background-color:#f5f6fa; font-family:'Segoe UI',Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f6fa; padding:30px 0;">
      <tr><td align="center">
        <table width="540" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 15px rgba(0,0,0,0.06);">
          <tr>
            <td style="background-color:#ff3f34; padding:26px 30px; text-align:center;">
              <h1 style="margin:0; color:#ffffff; font-size:24px; letter-spacing:1px; font-weight:700;">AGRO NARANJITO #1</h1>
              <p style="margin:4px 0 0; color:rgba(255,255,255,0.85); font-size:13px;">Comprobante Digital de Venta · ${fecha}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 30px 10px;">
              <p style="margin:0 0 4px; font-size:12px; color:#888; text-transform:uppercase; letter-spacing:.5px;">Titular del Documento</p>
              <p style="margin:0; font-size:17px; font-weight:600; color:#1e272e;">${cliente || "Consumidor Final"}</p>
              ${cedula ? `<p style="margin:4px 0 0; font-size:13px; color:#555;"><b>RUC / Cédula:</b> ${cedula}</p>` : ""}
              <span style="display:inline-block; margin-top:10px; padding:4px 14px; background-color:${tipoBadgeColor}; color:#ffffff; border-radius:20px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">${tipoPago}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:15px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:5px;">
                <thead>
                  <tr style="background-color:#f8f9fa;">
                    <th style="padding:10px; text-align:left; font-size:12px; color:#777; font-weight:600; text-transform:uppercase; border-bottom:1px solid #ddd;">Detalle</th>
                    <th style="padding:10px; text-align:center; font-size:12px; color:#777; font-weight:600; text-transform:uppercase; border-bottom:1px solid #ddd; width:50px;">Cant.</th>
                    <th style="padding:10px; text-align:right; font-size:12px; color:#777; font-weight:600; text-transform:uppercase; border-bottom:1px solid #ddd; width:80px;">P. Unit</th>
                    <th style="padding:10px; text-align:right; font-size:12px; color:#777; font-weight:600; text-transform:uppercase; border-bottom:1px solid #ddd; width:90px;">Total</th>
                  </tr>
                </thead>
                <tbody>${filas}</tbody>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 30px 25px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${descuentoRow}
                ${detallePago}
                ${sriBadge}
                <tr>
                  <td colspan="2"><hr style="border:none; border-top:2px dashed #f0f0f0; margin:12px 0;"></td>
                </tr>
                <tr>
                  <td style="font-size:16px; font-weight:700; color:#1e272e;">IMPORTE NETO RECAUDADO</td>
                  <td style="text-align:right; font-size:22px; font-weight:700; color:#ff3f34;">$${Number(totalFinal).toFixed(2)}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa; padding:20px 30px; text-align:center; border-top:1px solid #f0f0f0;">
              <p style="margin:0; font-size:14px; color:#2c3e50; font-weight:500;">¡Gracias por depositar su confianza en nosotros! 😊</p>
              <p style="margin:4px 0 0; font-size:11px; color:#7f8c8d;">Agro Naranjito #1 · Nota: Este documento digital es un comprobante automático de caja.</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
  </html>
  `;
}

const mapearDocs = (snapshot) => {
  const docs = [];
  snapshot.forEach(doc => docs.push({ _id: doc.id, ...doc.data() }));
  return docs;
};

// =========================================================================
// 4. MOTOR DE ALERTAS ACTIVAS - GUARDIÁN DE CADUCIDADES
// =========================================================================
async function ejecutarRevisionCaducidades() {
  if (!BREVO_API_KEY) return console.log("⚠️ Guardián abortado: Brevo API no configurada.");
  console.log("🕒 Guardián de Inventario: Iniciando escaneo diario de caducidades...");

  try {
    const snapshot = await db.collection('productos').get();
    const hoy = new Date();
    hoy.setHours(0,0,0,0);

    let listaVencidos    = [];
    let listaCriticos    = [];
    let listaPreventivos = [];

    snapshot.forEach(doc => {
      const p = doc.data();
      if (p.caducidad) {
        let fechaProd  = new Date(p.caducidad + "T00:00:00");
        let diffTiempo = fechaProd - hoy;
        let diffDias   = Math.ceil(diffTiempo / (1000 * 60 * 60 * 24));

        const item = {
          nombre: p.nombre || "Sin Nombre",
          codigo: p.codigo || "-",
          stock:  p.stock  ?? 0,
          fecha:  p.caducidad,
          dias:   diffDias
        };

        if (diffDias < 0)         listaVencidos.push(item);
        else if (diffDias <= 30)  listaCriticos.push(item);
        else if (diffDias <= 90)  listaPreventivos.push(item);
      }
    });

    if (listaVencidos.length === 0 && listaCriticos.length === 0 && listaPreventivos.length === 0) {
      console.log("✅ Guardián de Inventario: Cero productos en riesgo de caducidad hoy.");
      return;
    }

    const mapearFilasHTML = (arr, badgeColor, textoBadge) => arr.map(i => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:left;"><b>${i.nombre}</b><br><small style="color:#777;">Cód: ${i.codigo}</small></td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:center; font-weight:bold;">${i.stock} un.</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:center; font-family:monospace;">${i.fecha}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right;"><span style="background:${badgeColor}; color:white; padding:3px 8px; border-radius:5px; font-size:12px; font-weight:bold;">${textoBadge} (${i.dias < 0 ? 'Hace ' + Math.abs(i.dias) : i.dias} d)</span></td>
      </tr>
    `).join("");

    let cuerpoHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family:'Segoe UI',sans-serif; background:#f4f6f9; padding:20px; color:#333;">
      <div style="max-width:650px; background:white; margin:0 auto; border-radius:12px; overflow:hidden; box-shadow:0 4px 10px rgba(0,0,0,0.05); border-top:5px solid #ff3f34;">
        <div style="background:#1e272e; padding:20px; text-align:center; color:white;">
          <h2 style="margin:0;">🚨 NEXUS — REPORTE DE CADUCIDADES</h2>
          <p style="margin:5px 0 0; color:#aaa; font-size:14px;">Control de vencimientos automático para Agro Naranjito #1</p>
        </div>
        <div style="padding:24px;">
          <p>Estimado Administrador, se han localizado las siguientes alertas prioritarias en su bodega:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:15px;">
            <thead>
              <tr style="background:#f8f9fa; border-bottom:2px solid #ddd; font-size:13px; color:#555;">
                <th style="padding:10px; text-align:left;">Producto</th>
                <th style="padding:10px; text-align:center;">Stock</th>
                <th style="padding:10px; text-align:center;">Fecha Venc.</th>
                <th style="padding:10px; text-align:right;">Estado</th>
              </tr>
            </thead>
            <tbody>
              ${listaVencidos.length    ? mapearFilasHTML(listaVencidos,    '#e74c3c', '⚠️ Vencido')  : ''}
              ${listaCriticos.length    ? mapearFilasHTML(listaCriticos,    '#e67e22', '⏳ Crítico')  : ''}
              ${listaPreventivos.length ? mapearFilasHTML(listaPreventivos, '#f1c40f', '🕒 3 Meses') : ''}
            </tbody>
          </table>
          <p style="margin-top:25px; font-size:13px; color:#7f8c8d; text-align:center;">Nexus Core System · Este correo se genera automáticamente cada 24 horas.</p>
        </div>
      </div>
    </body>
    </html>`;

    await enviarCorreoBrevo({
      to:       'ad85ef001@smtp-brevo.com',
      subject:  `🚨 ALERTA BODEGA: ${listaVencidos.length} Vencidos / ${listaCriticos.length} Críticos detectados`,
      html:     cuerpoHtml,
      fromName: 'NEXUS Guardián'
    });

    console.log("📧 Correo consolidado de alertas enviado exitosamente al administrador.");
  } catch (error) {
    console.error("❌ Fallo en el proceso automatizado del Guardián:", error.message);
  }
}

function iniciarGuardianCaducidades() {
  setTimeout(ejecutarRevisionCaducidades, 5000);
  const VEINTICUATRO_HORAS = 1000 * 60 * 60 * 24;
  setInterval(ejecutarRevisionCaducidades, VEINTICUATRO_HORAS);
}

// =========================================================================
// 5. ENDPOINTS API REST
// =========================================================================

app.get('/health', (req, res) => {
  res.json({ ok: true, message: "NEXUS Core Engine activo", time: new Date() });
});

app.get('/inventario/forzar-alerta', async (req, res) => {
  await ejecutarRevisionCaducidades();
  res.json({ ok: true, mensaje: "Escaneo del guardián forzado manualmente." });
});

async function registrarMovimiento({ tipo, codigo, nombre, cantidad, motivo }) {
  const ahora = new Date();
  await db.collection('movimientos-inventario').add({
    tipo:     tipo     || "entrada",
    codigo:   codigo   || "-",
    nombre:   nombre   || "Sin Nombre",
    cantidad: Number(cantidad || 0),
    fecha:    ahora.toISOString().split('T')[0],
    hora:     ahora.toLocaleTimeString('es-EC', { hour12: false, timeZone: 'America/Guayaquil' }),
    motivo:   motivo   || "Actualización manual"
  });
}

// =========================================================================
// PRODUCTOS
// =========================================================================

app.get('/productos', async (req, res) => {
  try {
    const snapshot = await db.collection('productos').get();
    res.json(mapearDocs(snapshot));
  } catch (err) {
    console.error("Error al obtener productos:", err);
    res.json([]);
  }
});

app.post('/productos', async (req, res) => {
  try {
    const nuevoProducto = {
      codigo:       req.body.codigo       || "",
      nombre:       req.body.nombre       || "Sin Nombre",
      precioCompra: Number(req.body.precioCompra || 0),
      precioVenta:  Number(req.body.precioVenta  || 0),
      stock:        Number(req.body.stock        || 0),
      caducidad:    req.body.caducidad ? req.body.caducidad : null
    };
    await db.collection('productos').add(nuevoProducto);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno al crear producto" });
  }
});

app.put('/productos/:id', async (req, res) => {
  try {
    const actualizaciones = {};
    if (req.body.codigo       !== undefined) actualizaciones.codigo       = req.body.codigo;
    if (req.body.nombre       !== undefined) actualizaciones.nombre       = req.body.nombre;
    if (req.body.precioCompra !== undefined) actualizaciones.precioCompra = Number(req.body.precioCompra);
    if (req.body.precioVenta  !== undefined) actualizaciones.precioVenta  = Number(req.body.precioVenta);
    if (req.body.stock        !== undefined) actualizaciones.stock        = Number(req.body.stock);
    if (req.body.caducidad    !== undefined) actualizaciones.caducidad    = req.body.caducidad ? req.body.caducidad : null;

    await db.collection('productos').doc(req.params.id).update(actualizaciones);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno al editar propiedades del producto" });
  }
});

app.put('/productos/agregar/:id', async (req, res) => {
  try {
    const docRef = db.collection('productos').doc(req.params.id);
    const doc    = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Documento objetivo inexistente" });
    const p = doc.data();

    const updates = { stock: (p.stock || 0) + Number(req.body.cantidad) };
    if (req.body.caducidad !== undefined) updates.caducidad = req.body.caducidad;

    await docRef.update(updates);

    await registrarMovimiento({
      tipo:     "entrada",
      codigo:   p.codigo || "-",
      nombre:   p.nombre || "Sin Nombre",
      cantidad: Number(req.body.cantidad),
      motivo:   req.body.motivo || "Reabastecimiento de bodega"
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno al reaprovisionar stock" });
  }
});

app.put('/productos/vender/:id', async (req, res) => {
  try {
    const docRef = db.collection('productos').doc(req.params.id);
    const doc    = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "El producto no existe en el catálogo" });
    const p = doc.data();
    let nuevoStock = (p.stock || 0) - Number(req.body.cantidad);
    if (nuevoStock < 0) nuevoStock = 0;
    await docRef.update({ stock: nuevoStock });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error de inventario al procesar el descuento posventa" });
  }
});

app.delete('/productos/:id', async (req, res) => {
  try {
    await db.collection('productos').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno al purgar producto" });
  }
});

// =========================================================================
// HISTORIAL DE MOVIMIENTOS DE INVENTARIO
// =========================================================================

app.get('/movimientos-inventario', async (req, res) => {
  try {
    const snapshot = await db.collection('movimientos-inventario').orderBy('fecha', 'desc').get();
    res.json(mapearDocs(snapshot));
  } catch (err) {
    console.error("❌ Error al obtener movimientos de inventario:", err);
    res.status(500).json([]);
  }
});

app.post('/movimientos-inventario', async (req, res) => {
  try {
    const nuevoMovimiento = {
      tipo:     req.body.tipo     || "entrada",
      codigo:   req.body.codigo   || "-",
      nombre:   req.body.nombre   || "Sin Nombre",
      cantidad: Number(req.body.cantidad || 0),
      fecha:    req.body.fecha    || new Date().toISOString().split('T')[0],
      hora:     req.body.hora     || new Date().toLocaleTimeString('es-EC', { hour12: false }),
      motivo:   req.body.motivo   || "Actualización manual"
    };

    await db.collection('movimientos-inventario').add(nuevoMovimiento);
    res.json({ ok: true, mensaje: "Movimiento asentado en auditoría" });
  } catch (err) {
    console.error("❌ Error al guardar movimiento en Firestore:", err);
    res.status(500).json({ error: "Error interno al guardar el historial" });
  }
});

// =========================================================================
// CLIENTES
// =========================================================================

app.post('/clientes', async (req, res) => {
  try {
    const nuevoCliente = {
      nombre:      req.body.nombre     || "Sin Nombre",
      cedula:      req.body.cedula     || "Sin Cédula",
      direccion:   req.body.direccion  || "",
      telefono:    req.body.telefono   || "",
      correo:      req.body.correo     || "",
      deudaTotal:  Number(req.body.deudaTotal  || 0),
      deudaActual: Number(req.body.deudaActual || 0),
      estado:      req.body.estado     || "normal",
      fecha:       req.body.fecha ? new Date(req.body.fecha).toISOString() : new Date().toISOString()
    };
    const resultado = await db.collection('clientes').add(nuevoCliente);
    res.json({ ok: true, cliente: { _id: resultado.id, ...nuevoCliente } });
  } catch (err) {
    console.error("❌ Error registrando cliente:", err);
    res.status(500).json({ error: "Error de persistencia", detalle: err.message });
  }
});

app.get('/clientes', async (req, res) => {
  try {
    const snapshot = await db.collection('clientes').orderBy('fecha', 'desc').get();
    res.json(mapearDocs(snapshot));
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

app.post('/clientes/sumar-deuda', async (req, res) => {
  try {
    const { cedula, total } = req.body;
    const snapshot = await db.collection('clientes').where('cedula', '==', cedula).get();
    if (snapshot.empty) return res.status(404).json({ error: "Cliente no registrado en la base de datos" });
    const docRef  = snapshot.docs[0].ref;
    const cliente = snapshot.docs[0].data();
    const deudaTotal  = (cliente.deudaTotal  || 0) + Number(total);
    const deudaActual = (cliente.deudaActual || 0) + Number(total);
    await docRef.update({ deudaTotal, deudaActual, estado: "deudor" });
    res.json({ ok: true, cliente: { _id: docRef.id, ...cliente, deudaTotal, deudaActual, estado: "deudor" } });
  } catch (err) {
    res.status(500).json({ error: "Error crítico al cargar línea de crédito" });
  }
});

app.post('/clientes/abonar', async (req, res) => {
  try {
    const { cedula, monto } = req.body;
    const snapshot = await db.collection('clientes').where('cedula', '==', cedula).get();
    if (snapshot.empty) return res.status(404).json({ error: "Titular no encontrado" });
    const docRef  = snapshot.docs[0].ref;
    const cliente = snapshot.docs[0].data();
    let deudaActual = (cliente.deudaActual || 0) - Number(monto);
    let estado = cliente.estado;
    if (deudaActual <= 0) { deudaActual = 0; estado = "normal"; }
    await docRef.update({ deudaActual, estado });
    res.json({ ok: true, cliente: { _id: docRef.id, ...cliente, deudaActual, estado } });
  } catch (err) {
    res.status(500).json({ error: "Error de red al aplicar abono parcial" });
  }
});

app.put('/clientes/editar', async (req, res) => {
  try {
    const { id, nombre, cedula, telefono, correo } = req.body;
    await db.collection('clientes').doc(id).update({ nombre, cedula, telefono, correo });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error al regresar ficha de cliente" });
  }
});

app.get('/clientes/:cedula', async (req, res) => {
  try {
    const snapshot = await db.collection('clientes').where('cedula', '==', req.params.cedula).get();
    if (snapshot.empty) return res.json(null);
    res.json({ _id: snapshot.docs[0].id, ...snapshot.docs[0].data() });
  } catch (err) {
    res.status(500).json(null);
  }
});

app.delete('/clientes/:id', async (req, res) => {
  try {
    await db.collection('clientes').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo eliminar el cliente seleccionado" });
  }
});

// =========================================================================
// CORREO
// =========================================================================

app.post('/correo/factura', async (req, res) => {
  console.log("📨 Petición entrante POST /correo/factura para:", req.body?.correo);
  const { correo, datos, carrito, tipoPago } = req.body;

  if (!correo) {
    return res.status(400).json({ error: "La dirección de correo destinataria es obligatoria." });
  }
  if (!BREVO_API_KEY) {
    return res.status(503).json({ error: "El servicio de correo (Brevo API) no está configurado." });
  }

  try {
    const htmlFactura = generarHTMLCorreo(datos, carrito, tipoPago);
    const subject     = `🧾 Comprobante Digital — ${datos?.cliente || "Cliente"} · Total: $${Number(datos?.totalFinal || 0).toFixed(2)}`;

    const resultado = await enviarCorreoBrevo({
      to: correo,
      subject,
      html: htmlFactura,
      fromName: 'Agro Naranjito #1'
    });

    if (!resultado.ok) {
      throw new Error(resultado.error);
    }

    console.log(`📧 Factura despachada con éxito a: ${correo}`);
    res.json({ ok: true, mensaje: `Correo enviado satisfactoriamente a ${correo}` });
  } catch (err) {
    console.error("❌ Error crítico en Brevo API:", err.message);
    res.status(500).json({ error: "Fallo crítico al despachar correo electrónico.", detalle: err.message });
  }
});

// =========================================================================
// VENTAS
// =========================================================================

app.post('/ventas', async (req, res) => {
  try {
    const nuevaVenta = {
      ...req.body,
      fecha: req.body.fecha ? new Date(req.body.fecha).toISOString() : new Date().toISOString()
    };

    const ventaRef = await db.collection('ventas').add(nuevaVenta);

    if (Array.isArray(req.body.productos)) {
      const cliente = req.body.cliente || "Consumidor Final";
      for (const p of req.body.productos) {
        await registrarMovimiento({
          tipo:     "salida",
          codigo:   p.codigo || "-",
          nombre:   p.nombre || "Sin Nombre",
          cantidad: Number(p.amount || p.cantidad || 1),
          motivo:   req.body.tipo === "credito"
                      ? `[CREDITO] Venta — Cliente: ${cliente}`
                      : `Venta — Cliente: ${cliente}`
        });
      }
    }

    const cajasSnapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (!cajasSnapshot.empty) {
      const cajaRef = cajasSnapshot.docs[0].ref;
      const caja    = cajasSnapshot.docs[0].data();

      if (req.body.tipo === "efectivo" || req.body.tipo === "transferencia") {
        caja.ingresos = (caja.ingresos || 0) + Number(req.body.total || 0);
        if (!caja.movimientos) caja.movimientos = [];

        if (req.body.tipo === "efectivo") {
          caja.movimientos.push({ tipo: "ingreso", monto: req.body.total, motivo: `Venta directa efectivo - Cliente: ${req.body.cliente}`, fecha: new Date().toISOString() });
        } else {
          caja.movimientos.push({
            tipo:        "transferencia",
            monto:       Number(req.body.total || 0),
            motivo:      `Liquidación por Transferencia — ${req.body.banco || ""}`,
            banco:       req.body.banco       || "",
            cuenta:      req.body.cuenta      || "",
            comprobante: req.body.comprobante || "",
            remitente:   req.body.cliente     || "",
            fecha:       new Date().toISOString()
          });
        }
        await cajaRef.update(caja);
      }
    }

    if (req.body.tipo === "credito") {
      await db.collection('deudas').add({
        cliente:   req.body.cliente,
        cedula:    req.body.cedula    || "SIN CÉDULA",
        celular:   req.body.celular   || "",
        correo:    req.body.correo    || "",
        direccion: req.body.direccion || "",
        total:     req.body.total,
        pagado:    0,
        productos: req.body.productos || [],
        pagos:     [],
        fecha:     new Date().toISOString()
      });
    }

    if (req.body.tipo === "efectivo" || req.body.tipo === "transferencia") {
      const sri = await emitirFacturaInvoka({
        cliente:   req.body.cliente   || "CONSUMIDOR FINAL",
        cedula:    req.body.cedula    || null,
        correo:    req.body.correo    || null,
        carrito:   req.body.productos || [],
        descuento: req.body.descuento || 0,
        total:     req.body.total
      });

      if (sri.ok) {
        await ventaRef.update({
          claveAccesoSRI:     sri.claveAcceso   || null,
          autorizacionSRI:    sri.autorizacion  || null,
          facturaElectronica: true
        });
        console.log(`🧾 Clave SRI guardada en venta ${ventaRef.id}`);
      } else {
        console.warn(`⚠️ Invoka no autorizó la factura para venta ${ventaRef.id}:`, sri.error);
        await ventaRef.update({ facturaElectronica: false, errorSRI: sri.error || "Sin detalle" });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Fallo del sistema al asentar venta" });
  }
});

app.delete('/ventas/producto/:ventaId/:indice', async (req, res) => {
  try {
    const docRef = db.collection('ventas').doc(req.params.ventaId);
    const doc    = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Registro de transacción no localizado" });

    const venta  = doc.data();
    const indice = Number(req.params.indice);
    if (isNaN(indice) || indice < 0 || indice >= venta.productos.length) {
      return res.status(400).json({ error: "Direccionamiento indexado incorrecto" });
    }

    venta.productos.splice(indice, 1);

    if (venta.productos.length === 0) {
      await docRef.delete();
      return res.json({ msg: "Transacción purgada en su totalidad" });
    } else {
      venta.total = venta.productos.reduce((sum, p) => sum + (Number(p.precio || 0) * Number(p.amount || p.cantidad || 1)), 0);
      await docRef.update({ productos: venta.productos, total: venta.total });
      res.json({ msg: "Item removido e importes recalculados." });
    }
  } catch (err) {
    res.status(500).json({ error: "Error al modificar la venta consolidada" });
  }
});

app.delete('/ventas/dia', async (req, res) => {
  try {
    const { fecha } = req.body;
    if (!fecha) return res.status(400).json({ error: "Parámetro fecha ausente" });

    const inicio = new Date(fecha + "T00:00:00.000Z").toISOString();
    const fin    = new Date(fecha + "T23:59:59.999Z").toISOString();

    const snapshot = await db.collection('ventas')
      .where('fecha', '>=', inicio)
      .where('fecha', '<=', fin)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    res.json({ ok: true, msg: `Cierre forzado: ${snapshot.size} venta(s) eliminada(s)`, deleted: snapshot.size });
  } catch (err) {
    res.status(500).json({ error: "Fallo al purgar registros diarios" });
  }
});

// =========================================================================
// DEUDAS
// =========================================================================

app.get('/deudas', async (req, res) => {
  try {
    const snapshot = await db.collection('deudas').orderBy('fecha', 'desc').get();
    res.json(mapearDocs(snapshot));
  } catch (err) {
    res.json([]);
  }
});

app.post('/deudas', async (req, res) => {
  try {
    const nueva = {
      cliente:   req.body.cliente   || "",
      cedula:    req.body.cedula    || "-",
      celular:   req.body.celular   || "",
      direccion: req.body.direccion || "",
      correo:    req.body.correo    || "",
      total:     Number(req.body.total || 0),
      pagado:    0,
      productos: req.body.productos || [],
      pagos:     [],
      fecha:     req.body.fecha ? new Date(req.body.fecha).toISOString() : new Date().toISOString()
    };
    const resultado = await db.collection('deudas').add(nueva);
    res.json({ _id: resultado.id, ...nueva });
  } catch (err) {
    res.status(500).json({ error: "No se pudo aperturar la cuenta por cobrar" });
  }
});

app.post('/deudas/pagar', async (req, res) => {
  try {
    const docRef = db.collection('deudas').doc(req.body.id);
    const doc    = await docRef.get();
    if (!doc.exists) return res.json({ error: "Cuenta de deuda no localizada" });

    const deuda = doc.data();
    const monto = Number(req.body.monto);
    if (!monto || monto <= 0) return res.json({ error: "Importe introducido inválido" });

    const restante = deuda.total - deuda.pagado;
    if (monto > restante) return res.json({ error: "Sobrepago no permitido para el saldo restante" });

    const metodoPago  = req.body.tipoPago    || req.body.metodoPago || "efectivo";
    const banco       = req.body.banco       || "";
    const comprobante = req.body.comprobante || "";
    const remitente   = req.body.remitente   || "";

    deuda.pagado += monto;
    if (!deuda.pagos) deuda.pagos = [];

    deuda.pagos.push({
      monto,
      tipoPago: metodoPago,
      banco,
      comprobante,
      remitente,
      fecha: new Date().toISOString()
    });

    await docRef.update(deuda);

    const cajasSnapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (!cajasSnapshot.empty) {
      const cajaRef = cajasSnapshot.docs[0].ref;
      const caja    = cajasSnapshot.docs[0].data();

      caja.ingresos = (caja.ingresos || 0) + monto;
      if (!caja.movimientos) caja.movimientos = [];

      if (metodoPago === "transferencia") {
        caja.movimientos.push({
          tipo:        "transferencia",
          monto,
          motivo:      `Abono a Cuenta Diferida — ${deuda.cliente}`,
          banco,
          comprobante,
          remitente:   remitente || deuda.cliente || "",
          fecha:       new Date().toISOString()
        });
      } else {
        caja.movimientos.push({
          tipo:   "ingreso",
          monto,
          motivo: `Abono Efectivo Deuda — ${deuda.cliente}`,
          fecha:  new Date().toISOString()
        });
      }

      await cajaRef.update(caja);
    }

    res.json({
      cliente:   deuda.cliente,
      cedula:    deuda.cedula    || "-",
      celular:   deuda.celular   || "",
      monto,
      total:     deuda.total,
      restante:  deuda.total - deuda.pagado,
      pagado:    deuda.pagado,
      pagos:     deuda.pagos    || [],
      productos: deuda.productos || []
    });
  } catch (err) {
    res.status(500).json({ error: "Fallo crítico al asentar amortización" });
  }
});

app.put('/deudas/:id', async (req, res) => {
  try {
    const docRef = db.collection('deudas').doc(req.params.id);
    const doc    = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Cuenta no encontrada" });

    const deuda = doc.data();
    if (req.body.cliente   !== undefined) deuda.cliente   = req.body.cliente;
    if (req.body.cedula    !== undefined) deuda.cedula    = req.body.cedula;
    if (req.body.celular   !== undefined) deuda.celular   = req.body.celular;
    if (req.body.direccion !== undefined) deuda.direccion = req.body.direccion;
    if (req.body.total     !== undefined) deuda.total     = Number(req.body.total);
    if (req.body.productos !== undefined) deuda.productos = req.body.productos;
    if (req.body.pagado    !== undefined) deuda.pagado    = Number(req.body.pagado);
    if (req.body.pagos     !== undefined) deuda.pagos     = req.body.pagos;

    await docRef.update(deuda);
    res.json({ ok: true, deuda: { _id: docRef.id, ...deuda } });
  } catch (err) {
    res.status(500).json({ error: "Fallo técnico al editar balance de deuda" });
  }
});

app.delete('/deudas/:id', async (req, res) => {
  try {
    await db.collection('deudas').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error de borrado" });
  }
});

// =========================================================================
// CAJA
// =========================================================================

app.post('/caja/abrir', async (req, res) => {
  try {
    const monto = Number(req.body.monto);
    if (!monto || monto <= 0) return res.json({ error: "Capital inicial de apertura no válido" });

    const abiertaSnapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (!abiertaSnapshot.empty) {
      await abiertaSnapshot.docs[0].ref.update({ activa: false, horaCierre: new Date().toISOString() });
    }

    await db.collection('cajas').add({
      apertura:     monto,
      ingresos:     0,
      gastos:       0,
      activa:       true,
      horaApertura: new Date().toISOString(),
      movimientos:  [{ tipo: "inicio", monto, motivo: "Apertura operativa de caja", fecha: new Date().toISOString() }]
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error crítico al perturbar estado de caja" });
  }
});

app.get('/caja', async (req, res) => {
  try {
    const snapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (snapshot.empty) {
      return res.json({ apertura: 0, ingresos: 0, gastos: 0, transferencias: 0, saldo: 0 });
    }

    const caja = snapshot.docs[0].data();
    let transferencias = 0;
    const gastosLista        = [];
    const transferenciasList = [];
    const movimientosCaja    = [];

    (caja.movimientos || []).forEach(m => {
      if (m.tipo === "transferencia") {
        transferencias += m.monto;
        transferenciasList.push(m);
        movimientosCaja.push({
          tipo:         "entrada",
          producto:     `Transferencia — ${m.banco || ""}`,
          cantidad:     m.monto || 0,
          fecha:        m.fecha,
          horaRegistro: m.fecha ? new Date(m.fecha).toLocaleTimeString('es-EC') : "",
          nota:         m.comprobante ? `Ref: ${m.comprobante}` : ""
        });
      }
      if (m.tipo === "gasto") {
        gastosLista.push(m);
        movimientosCaja.push({
          tipo:         "salida",
          producto:     m.motivo || "Gasto de caja",
          cantidad:     m.monto  || 0,
          fecha:        m.fecha,
          horaRegistro: m.fecha ? new Date(m.fecha).toLocaleTimeString('es-EC') : "",
          nota:         "Egreso"
        });
      }
      if (m.tipo === "ingreso") {
        movimientosCaja.push({
          tipo:         "entrada",
          producto:     m.motivo || "Ingreso",
          cantidad:     m.monto  || 0,
          fecha:        m.fecha,
          horaRegistro: m.fecha ? new Date(m.fecha).toLocaleTimeString('es-EC') : "",
          nota:         "Ingreso efectivo"
        });
      }
    });

    const apertura = new Date(caja.horaApertura).getTime();
    const ahora    = Date.now();

    const movInvSnapshot = await db.collection('movimientos-inventario')
      .orderBy('fecha', 'desc')
      .limit(500)
      .get();

    movInvSnapshot.forEach(doc => {
      const m = doc.data();
      if (m.motivo && m.motivo.startsWith('[CREDITO]')) return;
      const fechaHoraStr = `${m.fecha}T${m.hora || "00:00:00"}`;
      const ts           = new Date(fechaHoraStr).getTime();

      if (ts >= apertura && ts <= ahora) {
        movimientosCaja.push({
          tipo:         m.tipo === "entrada" ? "entrada" : "salida",
          producto:     m.nombre   || m.motivo || "Producto",
          cantidad:     m.cantidad || 0,
          fecha:        fechaHoraStr,
          horaRegistro: m.hora || new Date(fechaHoraStr).toLocaleTimeString('es-EC'),
          nota:         m.motivo   || "",
          codigo:       m.codigo   || ""
        });
      }
    });

    movimientosCaja.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

    res.json({
      apertura:          caja.apertura,
      ingresos:          caja.ingresos,
      transferencias,
      gastos:            caja.gastos,
      saldo:             caja.apertura + caja.ingresos - caja.gastos,
      horaApertura:      caja.horaApertura,
      gastosLista,
      transferenciasList,
      movimientos:       movimientosCaja
    });
  } catch (err) {
    console.error("❌ Error al leer caja activa:", err.message);
    res.json({ apertura: 0, ingresos: 0, gastos: 0, transferencias: 0, saldo: 0 });
  }
});

app.post('/caja/gasto', async (req, res) => {
  try {
    const snapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (snapshot.empty) return res.json({ error: "Ninguna terminal de caja se encuentra activa" });

    const docRef = snapshot.docs[0].ref;
    const caja   = snapshot.docs[0].data();
    const monto  = Number(req.body.monto || 0);
    const motivo = req.body.motivo || "Gasto misceláneo de caja";
    if (!monto || monto <= 0) return res.json({ error: "Importe inválido" });

    caja.gastos = (caja.gastos || 0) + monto;
    if (!caja.movimientos) caja.movimientos = [];
    caja.movimientos.push({ tipo: "gasto", monto, motivo, fecha: new Date().toISOString() });
    await docRef.update(caja);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error de red al consolidar débito" });
  }
});

app.post('/caja/ingreso', async (req, res) => {
  try {
    const snapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (snapshot.empty) return res.json({ error: "Ninguna terminal de caja se encuentra activa" });

    const docRef = snapshot.docs[0].ref;
    const caja   = snapshot.docs[0].data();
    const monto  = Number(req.body.monto || 0);
    const motivo = req.body.motivo || req.body.producto || "Entrada de mercadería";
    if (!monto || monto <= 0) return res.json({ error: "Importe inválido" });

    caja.ingresos = (caja.ingresos || 0) + monto;
    if (!caja.movimientos) caja.movimientos = [];
    caja.movimientos.push({
      tipo:         "ingreso",
      monto,
      motivo,
      producto:     req.body.producto     || motivo,
      cantidad:     monto,
      nota:         req.body.nota         || "",
      horaRegistro: req.body.horaRegistro || new Date().toLocaleTimeString('es-EC'),
      fecha:        new Date().toISOString()
    });
    await docRef.update(caja);

    await registrarMovimiento({
      tipo:     "entrada",
      codigo:   req.body.codigo   || "-",
      nombre:   req.body.producto || motivo,
      cantidad: monto,
      motivo:   req.body.nota     || "Entrada registrada desde panel de flujo"
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error al registrar ingreso de mercadería" });
  }
});

app.post('/caja/transferencia', async (req, res) => {
  try {
    const snapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (snapshot.empty) return res.json({ error: "La caja se encuentra cerrada" });

    const docRef = snapshot.docs[0].ref;
    const caja   = snapshot.docs[0].data();
    const monto  = Number(req.body.monto || 0);
    if (!monto || monto <= 0) return res.json({ error: "Importe bancario fuera de rango" });

    caja.ingresos = (caja.ingresos || 0) + monto;
    if (!caja.movimientos) caja.movimientos = [];
    caja.movimientos.push({
      tipo:        "transferencia",
      monto,
      motivo:      `Ingreso directo por transferencia - ${req.body.banco || ""}`,
      banco:       req.body.banco       || "",
      cuenta:      req.body.cuenta      || "",
      comprobante: req.body.comprobante || "",
      remitente:   req.body.remitente   || "",
      fecha:       new Date().toISOString()
    });
    await docRef.update(caja);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Fallo de comunicación en asiento bancario" });
  }
});

app.post('/caja/cerrar', async (req, res) => {
  try {
    const snapshot = await db.collection('cajas').where('activa', '==', true).get();
    if (snapshot.empty) return res.json({ error: "No hay actividades vigentes en caja" });

    const docRef = snapshot.docs[0].ref;
    const caja   = snapshot.docs[0].data();
    const real   = Number(req.body.montoReal);
    const dejar  = Number(req.body.dejar || 0);
    const esperado   = caja.apertura + caja.ingresos - caja.gastos;
    const diferencia = real - esperado;

    let transferencias = 0;
    const gastosLista = [], transferenciasList = [];
    (caja.movimientos || []).forEach(m => {
      if (m.tipo === "gasto")         gastosLista.push(m);
      if (m.tipo === "transferencia") { transferenciasList.push(m); transferencias += m.monto; }
    });

    caja.activa     = false;
    caja.cierre     = real;
    caja.horaCierre = new Date().toISOString();
    caja.dejado     = dejar;
    caja.movimientos.push({ tipo: "cierre", monto: real, motivo: `Cierre contable de jornada | Fondo retenido: $${dejar}`, fecha: new Date().toISOString() });
    await docRef.update(caja);

    if (dejar > 0) {
      await db.collection('cajas').add({
        apertura:     dejar,
        ingresos:     0,
        gastos:       0,
        activa:       true,
        horaApertura: new Date().toISOString(),
        movimientos:  [{ tipo: "inicio", monto: dejar, motivo: "Fondo de apertura automático poscierre", fecha: new Date().toISOString() }]
      });
    }

    res.json({ apertura: caja.apertura, ingresos: caja.ingresos, transferencias, gastos: caja.gastos, esperado, real, diferencia, dejar, fechaApertura: caja.horaApertura, fechaCierre: caja.horaCierre, gastosLista, transferenciasList, movimientos: caja.movimientos });
  } catch (err) {
    res.status(500).json({ error: "Fallo general en protocolo de arqueo" });
  }
});

app.get('/caja/historial', async (req, res) => {
  try {
    const snapshot = await db.collection('cajas')
      .where('activa', '==', false)
      .orderBy('horaCierre', 'desc')
      .limit(50)
      .get();

    const movInvSnapshot = await db.collection('movimientos-inventario')
      .orderBy('fecha', 'desc')
      .get();

    const todosMovInv = [];
    movInvSnapshot.forEach(doc => todosMovInv.push({ _id: doc.id, ...doc.data() }));

    const historial = mapearDocs(snapshot).map(c => {
      let transferencias = 0;
      const gastosLista        = [];
      const transferenciasList = [];
      const movimientos        = [];

      (c.movimientos || []).forEach(m => {
        if (m.tipo === "gasto") {
          gastosLista.push(m);
          movimientos.push({
            tipo:         "salida",
            producto:     m.motivo || "Gasto de caja",
            cantidad:     m.monto  || 0,
            fecha:        m.fecha,
            horaRegistro: m.fecha ? new Date(m.fecha).toLocaleTimeString('es-EC') : "",
            nota:         "Egreso de caja"
          });
        }
        if (m.tipo === "transferencia") {
          transferenciasList.push(m);
          transferencias += m.monto;
          movimientos.push({
            tipo:         "entrada",
            producto:     `Transferencia — ${m.banco || ""}`,
            cantidad:     m.monto || 0,
            fecha:        m.fecha,
            horaRegistro: m.fecha ? new Date(m.fecha).toLocaleTimeString('es-EC') : "",
            nota:         m.comprobante ? `Ref: ${m.comprobante}` : ""
          });
        }
        if (m.tipo === "ingreso") {
          movimientos.push({
            tipo:         "entrada",
            producto:     m.motivo || "Ingreso de caja",
            cantidad:     m.monto  || 0,
            fecha:        m.fecha,
            horaRegistro: m.fecha ? new Date(m.fecha).toLocaleTimeString('es-EC') : "",
            nota:         "Ingreso efectivo"
          });
        }
      });

      const apertura = new Date(c.horaApertura).getTime();
      const cierre   = new Date(c.horaCierre).getTime();

      todosMovInv.forEach(m => {
        const fechaHoraStr = `${m.fecha}T${m.hora || "00:00:00"}`;
        const ts = new Date(fechaHoraStr).getTime();

        if (ts >= apertura && ts <= cierre) {
          movimientos.push({
            tipo:         m.tipo === "entrada" ? "entrada" : "salida",
            producto:     m.nombre   || m.motivo || "Producto",
            cantidad:     m.cantidad || 0,
            fecha:        fechaHoraStr,
            horaRegistro: m.hora || new Date(fechaHoraStr).toLocaleTimeString('es-EC'),
            nota:         m.motivo   || "",
            codigo:       m.codigo   || ""
          });
        }
      });

      movimientos.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

      return {
        fechaApertura:    c.horaApertura,
        fechaCierre:      c.horaCierre,
        apertura:         c.apertura,
        ingresos:         c.ingresos,
        transferencias,
        gastos:           c.gastos,
        real:             c.cierre,
        esperado:         c.apertura + c.ingresos - c.gastos,
        diferencia:       c.cierre - (c.apertura + c.ingresos - c.gastos),
        dejar:            c.dejado || 0,
        gastosLista,
        transferenciasList,
        movimientos
      };
    });

    res.json(historial);
  } catch (err) {
    console.error("❌ Error en historial de cajas:", err.message);
    res.status(500).json({ error: "Fallo de lectura en base histórica" });
  }
});

// =========================================================================
// ANÁLISIS
// =========================================================================

app.get('/analisis', async (req, res) => {
  try {
    const snapshot = await db.collection('ventas').get();
    const ventas   = mapearDocs(snapshot);

    let totalGeneral = 0, efectivo = 0, credito = 0, transferencia = 0;
    const productos = {}, porDia = {}, porMes = {};

    ventas.forEach(v => {
      const total = Number(v.total || 0);
      totalGeneral += total;
      if (v.tipo === "efectivo")      efectivo++;
      if (v.tipo === "credito")       credito++;
      if (v.tipo === "transferencia") transferencia++;

      let dia = "Desconocido", mes = "Desconocido";
      try { if (v.fecha) { dia = v.fecha.split("T")[0]; mes = v.fecha.slice(0, 7); } } catch (_) {}

      porDia[dia] = (porDia[dia] || 0) + total;
      porMes[mes] = (porMes[mes] || 0) + total;

      if (Array.isArray(v.productos)) {
        v.productos.forEach(p => {
          const nombre   = p.nombre   || "Sin nombre";
          const cantidad = Number(p.amount || p.cantidad || 1);
          const precio   = Number(p.precio   || 0);
          const costo    = Number(p.precioCosto || p.costo || 0);
          const ganancia = (precio - costo) * cantidad;

          if (!productos[nombre]) productos[nombre] = { nombre, vendidos: 0, ganancia: 0 };
          productos[nombre].vendidos += cantidad;
          productos[nombre].ganancia += ganancia;
        });
      }
    });

    const lista         = Object.values(productos);
    const masVendidos   = [...lista].sort((a, b) => b.vendidos  - a.vendidos ).slice(0, 5);
    const menosVendidos = [...lista].sort((a, b) => a.vendidos  - b.vendidos ).slice(0, 5);
    const masGanancia   = [...lista].sort((a, b) => b.ganancia  - a.ganancia ).slice(0, 5);
    const menosGanancia = [...lista].sort((a, b) => a.ganancia  - b.ganancia ).slice(0, 5);
    const clientesUnicos = new Set(ventas.map(v => v.cedula || v.cliente)).size;

    res.json({ ventas, totalGeneral, efectivo, credito, transferencia, clientes: clientesUnicos, porDia, porMes, masVendidos, menosVendidos, masGanancia, menosGanancia });
  } catch (err) {
    res.status(500).json({ error: "Fallo al procesar métricas gerenciales de auditoría" });
  }
});

// =========================================================================
// INVENTARIO — CADUCIDADES
// =========================================================================
app.get('/inventario/caducidades', async (req, res) => {
  try {
    const snapshot  = await db.collection('productos').get();
    const productos = [];

    snapshot.forEach(doc => {
      const p = doc.data();
      if (p.caducidad) {
        productos.push({
          _id:              doc.id,
          nombre:           p.nombre       || "Sin Nombre",
          codigo:           p.codigo       || "-",
          fechaVencimiento: p.caducidad,
          stock:            p.stock        ?? 0,
          precioVenta:      p.precioVenta  || 0,
          precioCompra:     p.precioCompra || 0
        });
      }
    });

    productos.sort((a, b) => new Date(a.fechaVencimiento) - new Date(b.fechaVencimiento));
    res.json(productos);
  } catch (err) {
    console.error("❌ Error al leer caducidades:", err.message);
    res.status(500).json({ error: "Error al obtener caducidades de Firestore" });
  }
});

// =========================================================================
// CHEQUES POR PAGAR (base de datos real — Firestore)
// =========================================================================

// Lista todos los cheques registrados
app.get('/cheques', async (req, res) => {
  try {
    const snapshot = await db.collection('cheques').orderBy('fecha', 'asc').get();
    res.json(mapearDocs(snapshot));
  } catch (err) {
    console.error("❌ Error al leer cheques:", err.message);
    res.status(500).json([]);
  }
});

// Crea un cheque nuevo
app.post('/cheques', async (req, res) => {
  try {
    const nuevo = {
      beneficiario:  req.body.beneficiario || "Sin especificar",
      monto:         Number(req.body.monto || 0),
      fecha:         req.body.fecha || hoyISOServidor(),
      numero:        req.body.numero || "",
      notas:         req.body.notas  || "",
      pagado:        false,
      fechaPago:     null,
      actualizadoEn: Date.now()
    };
    const resultado = await db.collection('cheques').add(nuevo);
    res.json({ ok: true, cheque: { _id: resultado.id, ...nuevo } });
  } catch (err) {
    console.error("❌ Error al crear cheque:", err.message);
    res.status(500).json({ error: "No se pudo registrar el cheque" });
  }
});

// Edita los datos de un cheque existente
app.put('/cheques/:id', async (req, res) => {
  try {
    const actualizaciones = { actualizadoEn: Date.now() };
    if (req.body.beneficiario !== undefined) actualizaciones.beneficiario = req.body.beneficiario;
    if (req.body.monto        !== undefined) actualizaciones.monto        = Number(req.body.monto);
    if (req.body.fecha        !== undefined) actualizaciones.fecha        = req.body.fecha;
    if (req.body.numero       !== undefined) actualizaciones.numero       = req.body.numero;
    if (req.body.notas        !== undefined) actualizaciones.notas        = req.body.notas;

    await db.collection('cheques').doc(req.params.id).update(actualizaciones);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error al editar cheque:", err.message);
    res.status(500).json({ error: "No se pudo editar el cheque" });
  }
});

// Marca un cheque como pagado
app.post('/cheques/pagar/:id', async (req, res) => {
  try {
    const docRef = db.collection('cheques').doc(req.params.id);
    const doc    = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Cheque no encontrado" });

    const fechaPago = req.body.fechaPago || hoyISOServidor();
    await docRef.update({ pagado: true, fechaPago, actualizadoEn: Date.now() });
    res.json({ ok: true, fechaPago });
  } catch (err) {
    console.error("❌ Error al marcar cheque como pagado:", err.message);
    res.status(500).json({ error: "No se pudo marcar el cheque como pagado" });
  }
});

// Revierte el pago de un cheque (lo vuelve a dejar pendiente)
app.post('/cheques/despagar/:id', async (req, res) => {
  try {
    await db.collection('cheques').doc(req.params.id).update({ pagado: false, fechaPago: null, actualizadoEn: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo revertir el pago del cheque" });
  }
});

// Elimina un cheque
app.delete('/cheques/:id', async (req, res) => {
  try {
    await db.collection('cheques').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo eliminar el cheque" });
  }
});

// Notas mensuales del calendario de cheques (una por mes, ej. "2026-07")
app.get('/cheques-notas', async (req, res) => {
  try {
    const snapshot = await db.collection('notas-cheques').get();
    const notas = {};
    snapshot.forEach(doc => { notas[doc.id] = (doc.data().texto || ""); });
    res.json(notas);
  } catch (err) {
    console.error("❌ Error al leer notas de cheques:", err.message);
    res.status(500).json({});
  }
});

app.put('/cheques-notas/:mes', async (req, res) => {
  try {
    await db.collection('notas-cheques').doc(req.params.mes).set({ texto: req.body.texto || "" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo guardar la nota del mes" });
  }
});

function hoyISOServidor() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// =========================================================================
// 6. INICIALIZACIÓN
// =========================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Motor NEXUS encendido en el puerto base asignado: ${PORT}`);
});
