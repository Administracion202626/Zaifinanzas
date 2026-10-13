// ============================================================================
//  Zaifi · Asistente de WhatsApp  (backend para Vercel)
//  Archivo: api/whatsapp.js
//
//  Qué hace:
//   - Recibe mensajes de WhatsApp (API oficial de Meta / WhatsApp Cloud API).
//   - Solo responde a los números autorizados.
//   - Entiende el mensaje con Claude (Anthropic) y responde con los datos de Zaifi.
//   - Puede registrar pagos / cobros / movimientos de caja, SIEMPRE pidiendo
//     confirmación antes de escribir nada.
//
//  Variables de entorno que hay que cargar en Vercel (Settings → Environment Variables):
//   ANTHROPIC_API_KEY   -> tu clave de Anthropic (sk-ant-...)
//   WA_TOKEN            -> token de WhatsApp Cloud API (de Meta)
//   WA_PHONE_ID         -> "Phone number ID" de tu número (de Meta)
//   WA_VERIFY_TOKEN     -> una palabra que inventás vos (la misma que pongas en Meta)
//   SUPABASE_URL        -> URL de tu Supabase (la de Zaifi)
//   SUPABASE_KEY        -> clave anon de Supabase (la de Zaifi)
//   AUTORIZADOS         -> números permitidos separados por coma, ej: 5491126232290,5491154880808
// ============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WA_TOKEN       = process.env.WA_TOKEN;
const WA_PHONE_ID    = process.env.WA_PHONE_ID;
const WA_VERIFY_TOKEN= process.env.WA_VERIFY_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const AUTORIZADOS    = (process.env.AUTORIZADOS || '').split(',').map(s=>s.replace(/\D/g,'')).filter(Boolean);

const MODEL = 'claude-3-5-sonnet-latest'; // podés cambiarlo por un modelo más nuevo desde la consola de Anthropic

// ---------- Helpers de Supabase (misma base que Zaifi: tabla zaifi_global) ----------
async function supa(path, method='GET', body){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers:{
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':'application/json',
      'Prefer': method==='POST' ? 'return=minimal' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if(method==='GET') return r.json();
  return r.ok;
}
async function leerTabla(tabla){
  const rows = await supa(`zaifi_global?tabla=eq.${encodeURIComponent(tabla)}&select=data`);
  return (Array.isArray(rows)? rows : []).map(x=>x.data).filter(Boolean);
}
// Upsert de un registro (borra la versión vieja por record_id y reinserta)
async function guardarRegistro(tabla, obj){
  const rid = obj.id || ('auto_'+Date.now());
  obj.id = rid;
  await supa(`zaifi_global?tabla=eq.${encodeURIComponent(tabla)}&record_id=eq.${encodeURIComponent(rid)}`, 'DELETE');
  await supa('zaifi_global', 'POST', [{ tabla, record_id: rid, data: obj }]);
  return obj;
}
const hoy = ()=> new Date().toISOString().split('T')[0];
const uid = ()=> Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const norm = s => (s||'').toString().toLowerCase().trim();

// ---------- Historial de conversación por número (para que entienda el contexto) ----------
async function getHistorial(phone){
  try{
    const rows = await supa(`zaifi_global?tabla=eq.bot_chats&record_id=eq.${encodeURIComponent(phone)}&select=data`);
    return (rows && rows[0] && rows[0].data && rows[0].data.messages) || [];
  }catch(e){ return []; }
}
async function setHistorial(phone, messages){
  const recorte = messages.slice(-12); // guardamos solo lo reciente
  await supa(`zaifi_global?tabla=eq.bot_chats&record_id=eq.${encodeURIComponent(phone)}`, 'DELETE');
  await supa('zaifi_global', 'POST', [{ tabla:'bot_chats', record_id:phone, data:{ messages:recorte } }]);
}

// ---------- WhatsApp: enviar mensaje ----------
async function enviarWhatsApp(to, texto){
  await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${WA_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ messaging_product:'whatsapp', to, type:'text', text:{ body: texto.slice(0,4000) } })
  });
}

// ---------- Herramientas que puede usar Claude ----------
const TOOLS = [
  { name:'resumen_general', description:'Devuelve un resumen de la situación: cuánto te deben (por cobrar), cuánto debés (por pagar), saldos de caja.', input_schema:{ type:'object', properties:{}, required:[] } },
  { name:'buscar', description:'Busca registros por nombre en una tabla (facturas, clientes, gastos, cxp, empleados, caja).', input_schema:{ type:'object', properties:{ tabla:{type:'string'}, texto:{type:'string'} }, required:['tabla','texto'] } },
  { name:'registrar_pago', description:'Registra un pago (egreso) a un gasto, cuenta por pagar o sueldo. Pedí confirmación antes de usar esta herramienta.', input_schema:{ type:'object', properties:{ nombre:{type:'string', description:'nombre del proveedor/gasto/empleado'}, monto:{type:'number'}, cuenta:{type:'string', description:'ODSA, Francisco García o Efectivo'} }, required:['nombre','monto'] } },
  { name:'registrar_cobro', description:'Registra un cobro (ingreso) de una factura/cliente. Pedí confirmación antes de usar esta herramienta.', input_schema:{ type:'object', properties:{ cliente:{type:'string'}, monto:{type:'number'}, cuenta:{type:'string'} }, required:['cliente','monto'] } },
  { name:'movimiento_caja', description:'Registra un movimiento de caja manual (ingreso o egreso). Pedí confirmación antes de usar esta herramienta.', input_schema:{ type:'object', properties:{ cuenta:{type:'string'}, tipo:{type:'string', enum:['ingreso','egreso']}, concepto:{type:'string'}, monto:{type:'number'} }, required:['cuenta','tipo','concepto','monto'] } }
];

// ---------- Ejecutar cada herramienta ----------
async function ejecutarTool(name, input){
  if(name==='resumen_general'){
    const [facturas, gastos, empleados, cxp, caja] = await Promise.all([leerTabla('facturas'),leerTabla('gastos'),leerTabla('empleados'),leerTabla('cxp'),leerTabla('caja')]);
    const porCobrar = facturas.filter(f=>f.estado!=='cobrada').reduce((a,f)=>a+Math.max(0,(+f.monto||0)-(+f.montoCobrado||0)),0);
    const porPagarG = gastos.reduce((a,g)=>a+Math.max(0,(+g.monto||0)-(+g.montoPagado||0)),0);
    const porPagarE = empleados.reduce((a,e)=>a+Math.max(0,(+e.sueldo||0)-(+e.montoPagado||0)),0);
    const porPagarC = cxp.filter(c=>!c.gastoId&&!c.empleadoId).reduce((a,c)=>a+Math.max(0,(+c.monto||0)-(+c.montoPagado||0)),0);
    const cuentas={}; caja.forEach(m=>{ const k=m.cuenta||'ODSA'; cuentas[k]=(cuentas[k]||0)+(m.tipo==='ingreso'?(+m.monto||0):-(+m.monto||0)); });
    return { por_cobrar: Math.round(porCobrar), por_pagar: Math.round(porPagarG+porPagarE+porPagarC), saldos_caja: cuentas };
  }
  if(name==='buscar'){
    const data = await leerTabla(input.tabla);
    const q = norm(input.texto);
    const campos = ['nombre','cliente','proveedor','descripcion','concepto','numero','razon'];
    const res = data.filter(x=> campos.some(c=> norm(x[c]).includes(q)) );
    return res.slice(0,15);
  }
  if(name==='registrar_pago'){
    const q=norm(input.nombre); const monto=+input.monto||0; const cuenta=input.cuenta||'ODSA';
    // Buscar en gastos, cxp, empleados
    const [gastos, cxp, empleados] = await Promise.all([leerTabla('gastos'),leerTabla('cxp'),leerTabla('empleados')]);
    let g = gastos.find(x=>norm(x.descripcion).includes(q)||norm(x.proveedor).includes(q));
    if(g){ g.montoPagado=Math.min((+g.montoPagado||0)+monto,+g.monto||0); g.estado=g.montoPagado>=(+g.monto||0)?'pagado':'pendiente'; await guardarRegistro('gastos',g); }
    else {
      let c = cxp.find(x=>!x.gastoId&&!x.empleadoId&&(norm(x.proveedor).includes(q)||norm(x.concepto).includes(q)));
      if(c){ c.montoPagado=Math.min((+c.montoPagado||0)+monto,+c.monto||0); c.estado=c.montoPagado>=(+c.monto||0)?'pagado':'pendiente'; await guardarRegistro('cxp',c); }
      else {
        let e = empleados.find(x=>norm(x.nombre).includes(q));
        if(e){ e.montoPagado=Math.min((+e.montoPagado||0)+monto,+e.sueldo||0); e.estado=e.montoPagado>=(+e.sueldo||0)?'pagado':'pendiente'; await guardarRegistro('empleados',e); }
        else return { ok:false, error:'No encontré "'+input.nombre+'" en gastos, cuentas por pagar ni empleados.' };
      }
    }
    await guardarRegistro('caja', { id:uid(), cuenta, tipo:'egreso', concepto:'Pago '+input.nombre, monto, medio:'Transferencia', fecha:hoy() });
    return { ok:true, mensaje:`Registré el pago de $${monto} a ${input.nombre} (sale de ${cuenta}).` };
  }
  if(name==='registrar_cobro'){
    const q=norm(input.cliente); const monto=+input.monto||0; const cuenta=input.cuenta||'ODSA';
    const facturas = await leerTabla('facturas');
    let f = facturas.filter(x=>x.estado!=='cobrada' && norm(x.cliente).includes(q)).sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||''))[0];
    if(!f) return { ok:false, error:'No encontré una factura pendiente de '+input.cliente+'.' };
    f.montoCobrado=Math.min((+f.montoCobrado||0)+monto,+f.monto||0); f.estado=f.montoCobrado>=(+f.monto||0)?'cobrada':'pendiente';
    await guardarRegistro('facturas',f);
    await guardarRegistro('caja', { id:uid(), cuenta, tipo:'ingreso', concepto:'Cobro '+(f.numero||'')+' '+f.cliente, monto, medio:'Transferencia', fecha:hoy() });
    return { ok:true, mensaje:`Registré el cobro de $${monto} de ${f.cliente} (entra en ${cuenta}).` };
  }
  if(name==='movimiento_caja'){
    await guardarRegistro('caja', { id:uid(), cuenta:input.cuenta||'ODSA', tipo:input.tipo, concepto:input.concepto, monto:+input.monto||0, medio:'Otro', fecha:hoy() });
    return { ok:true, mensaje:`Registré ${input.tipo} de $${input.monto} en ${input.cuenta}.` };
  }
  return { ok:false, error:'Herramienta desconocida' };
}

const SYSTEM = `Sos el asistente de Zaifi, el sistema de gestión de la empresa ODSA, por WhatsApp.
Respondés en español rioplatense, claro y breve. Usás las herramientas para consultar o modificar datos reales.
REGLA IMPORTANTE: antes de registrar cualquier pago, cobro o movimiento (cualquier acción que CAMBIE datos),
primero explicás qué vas a hacer y pedís confirmación ("¿Confirmás? Respondé SÍ"). Solo ejecutás la herramienta
cuando la persona confirma explícitamente en un mensaje posterior. Para consultas (preguntas) no hace falta confirmar.
Las cuentas de caja son: ODSA, Francisco García y Efectivo. Si no te aclaran de qué cuenta, preguntá.`;

// ---------- Llamar a Claude con tool-use ----------
async function pensar(messages){
  let msgs = [...messages];
  for(let i=0;i<5;i++){ // hasta 5 pasos de herramientas
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
      body: JSON.stringify({ model:MODEL, max_tokens:1024, system:SYSTEM, tools:TOOLS, messages:msgs })
    });
    const data = await r.json();
    if(!data.content){ return { texto:'Tuve un problema para procesar eso. Probá de nuevo.', msgs }; }
    const toolUses = data.content.filter(c=>c.type==='tool_use');
    msgs.push({ role:'assistant', content:data.content });
    if(toolUses.length===0){
      const texto = data.content.filter(c=>c.type==='text').map(c=>c.text).join('\n').trim() || 'Listo.';
      return { texto, msgs };
    }
    const results=[];
    for(const t of toolUses){
      let out; try{ out=await ejecutarTool(t.name, t.input||{}); }catch(e){ out={ok:false,error:String(e)}; }
      results.push({ type:'tool_result', tool_use_id:t.id, content: JSON.stringify(out) });
    }
    msgs.push({ role:'user', content:results });
  }
  return { texto:'No pude terminar la operación, probá reformularlo.', msgs };
}

// ---------- Handler principal (Vercel) ----------
module.exports = async (req, res) => {
  // 1) Verificación del webhook (Meta hace un GET al configurarlo)
  if(req.method==='GET'){
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if(mode==='subscribe' && token===WA_VERIFY_TOKEN){ return res.status(200).send(challenge); }
    return res.status(403).send('Forbidden');
  }
  // 2) Mensajes entrantes
  if(req.method==='POST'){
    try{
      const body = req.body;
      const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if(!msg || msg.type!=='text'){ return res.status(200).send('ok'); }
      const from = (msg.from||'').replace(/\D/g,'');
      const texto = msg.text.body;

      // Autorización por número (comparamos los últimos 10 dígitos)
      const ok = AUTORIZADOS.some(a => a.slice(-10)===from.slice(-10));
      if(!ok){ await enviarWhatsApp(from, 'No tenés autorización para usar este asistente.'); return res.status(200).send('ok'); }

      const hist = await getHistorial(from);
      hist.push({ role:'user', content:texto });
      const { texto:respuesta, msgs } = await pensar(hist);
      await enviarWhatsApp(from, respuesta);
      await setHistorial(from, msgs);
      return res.status(200).send('ok');
    }catch(e){
      console.error('Error:', e);
      return res.status(200).send('ok'); // siempre 200 para que Meta no reintente en loop
    }
  }
  return res.status(405).send('Method not allowed');
};
