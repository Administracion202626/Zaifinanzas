// api/arca.js
// ─────────────────────────────────────────────────────────────────────────
// Backend de facturación electrónica de Zaifi contra ARCA (ex AFIP).
// Corre como función serverless en Vercel, en el mismo proyecto que el HTML.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   AFIP_SDK_TOKEN → access token de app.afipsdk.com          (obligatoria)
//   AFIP_CUIT      → CUIT que factura (en modo dev: 20409378472)
//   AFIP_ENV       → "dev" (pruebas) o "production" (facturas reales)
//   AFIP_CERT      → contenido del certificado .crt   (solo producción)
//   AFIP_KEY       → contenido de la clave privada .key (solo producción)
//
// El certificado y la clave viven SOLO acá. Nunca en el HTML.
// ─────────────────────────────────────────────────────────────────────────

const Afip = require('@afipsdk/afip.js');

const TIPO_CBTE = { A: 1, B: 6, C: 11 };
const DOC_VALIDOS = [80, 96, 99]; // CUIT, DNI, Consumidor Final

function err(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function getAfip() {
  const token = process.env.AFIP_SDK_TOKEN;
  const cuit = process.env.AFIP_CUIT;
  const prod = String(process.env.AFIP_ENV || 'dev').toLowerCase() === 'production';
  if (!token) throw err('Falta la variable AFIP_SDK_TOKEN en Vercel.', 500);
  if (!cuit) throw err('Falta la variable AFIP_CUIT en Vercel.', 500);

  const opts = { CUIT: Number(cuit), access_token: token, production: prod };
  if (prod) {
    if (!process.env.AFIP_CERT || !process.env.AFIP_KEY) {
      throw err('Modo producción: faltan AFIP_CERT y/o AFIP_KEY en Vercel.', 500);
    }
    opts.cert = process.env.AFIP_CERT;
    opts.key = process.env.AFIP_KEY;
  }
  return { afip: new Afip(opts), env: prod ? 'production' : 'dev', cuit: Number(cuit) };
}

// yyyymmdd de hoy (hora Argentina, para que la fecha del comprobante no se corra)
function hoyArg() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function handleStatus(res) {
  const { afip, env, cuit } = getAfip();
  const s = await afip.ElectronicBilling.getServerStatus();
  const ok = s && s.AppServer === 'OK' && s.DbServer === 'OK' && s.AuthServer === 'OK';
  return res.status(200).json({ ok, env, cuit, server: s });
}

async function handleEmitir(body, res) {
  const { afip, env } = getAfip();

  // ── Validación de entrada ────────────────────────────────────────────
  const tipo = String(body.tipo || '').toUpperCase();
  if (!TIPO_CBTE[tipo]) throw err('Tipo de comprobante inválido (usá A, B o C).');

  const ptoVta = parseInt(body.ptoVta, 10);
  if (!ptoVta || ptoVta < 1) throw err('Punto de venta inválido.');

  const docTipo = parseInt(body.docTipo, 10);
  if (!DOC_VALIDOS.includes(docTipo)) throw err('Tipo de documento inválido (80=CUIT, 96=DNI, 99=Cons. Final).');

  const docNro = docTipo === 99 ? 0 : parseInt(String(body.docNro || '').replace(/\D/g, ''), 10);
  if (docTipo !== 99 && (!docNro || isNaN(docNro))) throw err('Número de documento inválido.');
  if (tipo === 'A' && docTipo !== 80) throw err('La Factura A exige CUIT del receptor.');

  const condIva = parseInt(body.condIvaReceptor, 10);
  if (!condIva) throw err('Falta la condición de IVA del receptor.');

  const importe = Math.round((parseFloat(body.neto) || 0) * 100) / 100;
  if (!(importe > 0)) throw err('El importe tiene que ser mayor a cero.');

  // ── Cálculo de importes ──────────────────────────────────────────────
  // A y B: el importe recibido es NETO, se le suma IVA 21%.
  // C: sin discriminar IVA; el importe recibido es el TOTAL.
  let neto, iva, total;
  if (tipo === 'C') {
    neto = importe; iva = 0; total = importe;
  } else {
    neto = importe;
    iva = Math.round(neto * 21) / 100;
    total = Math.round((neto + iva) * 100) / 100;
  }

  // ── Número de comprobante: el siguiente al último autorizado ─────────
  const cbteTipo = TIPO_CBTE[tipo];
  const ultimo = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
  const numero = (Number(ultimo) || 0) + 1;

  const fecha = hoyArg();

  const data = {
    CantReg: 1,
    PtoVta: ptoVta,
    CbteTipo: cbteTipo,
    Concepto: 2,               // Servicios
    DocTipo: docTipo,
    DocNro: docNro,
    CbteDesde: numero,
    CbteHasta: numero,
    CbteFch: parseInt(fecha, 10),
    FchServDesde: parseInt(fecha, 10),
    FchServHasta: parseInt(fecha, 10),
    FchVtoPago: parseInt(fecha, 10),
    ImpTotal: total,
    ImpTotConc: 0,
    ImpNeto: neto,
    ImpOpEx: 0,
    ImpIVA: iva,
    ImpTrib: 0,
    MonId: 'PES',
    MonCotiz: 1,
    CondicionIVAReceptorId: condIva, // obligatorio desde RG 5616 (2025)
  };
  if (tipo !== 'C') {
    data.Iva = [{ Id: 5, BaseImp: neto, Importe: iva }]; // 5 = IVA 21%
  }

  const v = await afip.ElectronicBilling.createVoucher(data);
  if (!v || !v.CAE) throw err('ARCA no devolvió CAE. Revisá los datos e intentá de nuevo.', 502);

  return res.status(200).json({
    ok: true,
    env,
    tipo,
    ptoVta,
    numero,
    cae: String(v.CAE),
    caeVto: String(v.CAEFchVto || ''), // yyyymmdd
    neto, iva, total,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Usá POST.' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    body = body || {};

    if (body.action === 'status') return await handleStatus(res);
    if (body.action === 'emitir') return await handleEmitir(body, res);
    return res.status(400).json({ ok: false, error: 'Acción desconocida (usá "status" o "emitir").' });
  } catch (e) {
    const msg = e && e.message ? e.message : 'Error inesperado.';
    return res.status(e.status || 500).json({ ok: false, error: msg });
  }
};
