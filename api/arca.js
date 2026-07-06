// ══════════════════════════════════════════════════════════════
// ZAIFI × ARCA — Función serverless de Vercel
// Conecta Zaifi con la facturación electrónica de ARCA (ex AFIP)
// usando Afip SDK (https://docs.afipsdk.com)
//
// Variables de entorno necesarias (Vercel → Settings → Environment Variables):
//   AFIP_SDK_TOKEN  → access token de https://app.afipsdk.com (cuenta gratis)
//   AFIP_CUIT       → CUIT que factura. Para modo prueba usar: 20409378472
//   AFIP_ENV        → "dev" (pruebas) o "production" (facturas reales)
//   AFIP_CERT       → contenido del certificado .crt (solo producción)
//   AFIP_KEY        → contenido de la clave privada .key (solo producción)
// ══════════════════════════════════════════════════════════════
const Afip = require('@afipsdk/afip.js');

function crearAfip() {
  const CUIT = Number(process.env.AFIP_CUIT || 20409378472);
  const access_token = process.env.AFIP_SDK_TOKEN;
  if (!access_token) throw new Error('Falta configurar AFIP_SDK_TOKEN en Vercel');

  const opts = { CUIT, access_token };
  if (process.env.AFIP_ENV === 'production') {
    if (!process.env.AFIP_CERT || !process.env.AFIP_KEY) {
      throw new Error('Modo producción requiere AFIP_CERT y AFIP_KEY en Vercel');
    }
    opts.production = true;
    opts.cert = process.env.AFIP_CERT;
    opts.key  = process.env.AFIP_KEY;
  }
  return new Afip(opts);
}

module.exports = async (req, res) => {
  // CORS básico (mismo dominio en Vercel, pero por las dudas)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Usar POST' });

  const body = req.body || {};
  const action = body.action;

  try {
    const afip = crearAfip();

    // ── Probar conexión ──────────────────────────────────────
    if (action === 'status') {
      const st = await afip.ElectronicBilling.getServerStatus();
      return res.status(200).json({ ok:true, env: process.env.AFIP_ENV || 'dev', status: st });
    }

    // ── Último comprobante autorizado ────────────────────────
    if (action === 'ultimo') {
      const nro = await afip.ElectronicBilling.getLastVoucher(Number(body.ptoVta)||1, Number(body.cbteTipo)||6);
      return res.status(200).json({ ok:true, ultimo: nro });
    }

    // ── Emitir factura (solicitar CAE) ───────────────────────
    if (action === 'emitir') {
      const ptoVta    = Number(body.ptoVta) || 1;
      const cbteTipo  = Number(body.cbteTipo);          // 1=A, 6=B, 11=C
      const docTipo   = Number(body.docTipo);           // 80=CUIT, 96=DNI, 99=Cons.Final
      const docNro    = Number(body.docNro) || 0;
      const condIVA   = Number(body.condIVAReceptor);   // 1=RI, 4=Exento, 5=Cons.Final, 6=Monotributo
      const concepto  = Number(body.concepto) || 1;     // 1=Productos, 2=Servicios, 3=Ambos
      const neto      = Math.round((Number(body.neto)||0) * 100) / 100;

      if (!cbteTipo || !neto) return res.status(400).json({ ok:false, error:'Faltan datos: tipo de comprobante o importe' });
      if (cbteTipo === 1 && docTipo !== 80) return res.status(400).json({ ok:false, error:'La Factura A requiere CUIT del receptor' });

      // IVA: A y B discriminan 21%; C va sin IVA
      const esC   = cbteTipo === 11;
      const iva   = esC ? 0 : Math.round(neto * 21) / 100;
      const total = Math.round((neto + iva) * 100) / 100;

      const ultimo = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
      const nroCbte = ultimo + 1;

      const hoy = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().split('T')[0];
      const fchNum = parseInt(hoy.replace(/-/g,''));

      const data = {
        CantReg: 1,
        PtoVta: ptoVta,
        CbteTipo: cbteTipo,
        Concepto: concepto,
        DocTipo: docTipo,
        DocNro: docNro,
        CbteDesde: nroCbte,
        CbteHasta: nroCbte,
        CbteFch: fchNum,
        ImpTotal: total,
        ImpTotConc: 0,
        ImpNeto: neto,
        ImpOpEx: 0,
        ImpIVA: iva,
        ImpTrib: 0,
        MonId: 'PES',
        MonCotiz: 1,
        CondicionIVAReceptorId: condIVA || (esC ? 5 : (cbteTipo===1 ? 1 : 5)),
      };
      // Servicios: requiere período y vencimiento de pago
      if (concepto === 2 || concepto === 3) {
        data.FchServDesde = fchNum;
        data.FchServHasta = fchNum;
        data.FchVtoPago   = fchNum;
      }
      // Alícuotas de IVA (no aplica a Factura C)
      if (!esC) {
        data.Iva = [{ Id: 5, BaseImp: neto, Importe: iva }]; // Id 5 = 21%
      }

      const r = await afip.ElectronicBilling.createVoucher(data);

      return res.status(200).json({
        ok: true,
        env: process.env.AFIP_ENV || 'dev',
        cae: r.CAE,
        caeVto: r.CAEFchVto,
        nroCbte,
        ptoVta,
        cbteTipo,
        neto, iva, total,
        numero: String(ptoVta).padStart(4,'0') + '-' + String(nroCbte).padStart(8,'0'),
      });
    }

    return res.status(400).json({ ok:false, error:'Acción desconocida: ' + action });
  } catch (e) {
    console.error('Error ARCA:', e);
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  }
};
