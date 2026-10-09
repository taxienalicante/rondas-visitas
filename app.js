/* RONDAS COMERCIALES · PWA · Sistema RTT · v1.5 2026-10-09 */
(() => {
'use strict';

const API = (window.RONDAS_API || '').trim();
const DEMO = !API;
const LS = { auth: 'rondas_auth', data: 'rondas_data', queue: 'rondas_queue', filtro: 'rondas_filtro', filtroHoy: 'rondas_filtro_hoy' };
const TIPOS = { hotel: 'Hotel', clinica: 'Clínica', residencia: 'Residencia', negocio: 'Negocio', ambulatorio: 'Ambulatorio' };

/* ───────── estado ───────── */
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
let auth = ls.get(LS.auth, null);
let data = ls.get(LS.data, null);      // {sitios, paquetes, visitas, usuarios, ts}
let queue = ls.get(LS.queue, []);      // visitas pendientes de enviar
let syncing = false;
let syncError = '';
let volverA = '';   // lista desde la que se abrió la ficha (Hoy, paquete, panel)

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const horaAhora = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const eur = n => Number(n).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €';
const fmtFecha = iso => { iso = String(iso || ''); if (iso.includes('T')) { const d = new Date(iso); iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; } const p = iso.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0].slice(2)}` : (iso || ''); };
const uid = () => 'V-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nombreUsuario = u => (data?.usuarios || []).find(x => String(x.usuario) === String(u))?.nombre || `Usuario ${u}`;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ───────── API (Apps Script) ───────── */
async function call(action, body = {}) {
  if (DEMO) return demo(action, body);
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, usuario: auth?.usuario, pin: auth?.pin, ...body })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j.ok) { const e = new Error(j.error || 'Error'); e.server = true; throw e; }
  return j;
}

/* ───────── datos combinados (servidor + cola local) ───────── */
function visitas() {
  const m = new Map((data?.visitas || []).map(v => [v.id, v]));
  queue.forEach(v => m.set(v.id, { ...v, _pend: true }));
  return [...m.values()].filter(v => !v.borrado);
}
function visitasDe(sitioId) {
  return visitas().filter(v => v.sitio_id === sitioId)
    .sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora));
}
function ultimaVisita(sitioId) { return visitasDe(sitioId)[0] || null; }
function sitio(id) { return (data?.sitios || []).find(s => s.id === id); }
function paquetes() {
  const asig = new Map((data?.paquetes || []).map(p => [p.id, p.asignado_a || '']));
  const m = new Map();
  (data?.sitios || []).forEach(s => {
    if (!m.has(s.paquete)) m.set(s.paquete, { id: s.paquete, zona: s.zona, asignado_a: asig.get(s.paquete) || '', sitios: [] });
    m.get(s.paquete).sitios.push(s);
  });
  return [...m.values()];
}
const enRonda = s => !s.no_visitar;   // no_visitar = lo lleva Jorge: fuera del % y del punteo
/* ───────── sistema vivo: cuándo toca cada sitio ───────── */
const VOLVER = [['2s', '2 semanas', 14], ['1m', '1 mes', 30], ['3m', '3 meses', 90], ['6m', '6 meses', 180], ['fiel', 'Ya es cliente fiel', null], ['no', 'No volver', null]];
const volverDe = c => VOLVER.find(x => x[0] === c);
const CAD_DEF = 90;   // si no hay desenlace ni cadencia
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const PRIO = { A: 0, B: 1, C: 2 };
const ESTADOS = { 'pendiente': 'Pendiente', 'en seguimiento': 'En seguimiento', 'cliente ok': 'Cliente OK', 'no volver': 'No volver', 'esperar': 'Esperar' };

/* Reglas (gana la primera): estado no volver/esperar → fuera · fecha forzada por Hoteles posterior a la última visita →
   esa fecha · desenlace de la última visita · última visita + cadencia · sin visitas → pendiente (toca ya) */
function plan(s) {
  const u = ultimaVisita(s.id);
  const est = norm(s.estado);
  if (s.no_visitar) return { fuera: true, motivo: 'Lo lleva Jorge', u };
  if (est === 'no volver') return { fuera: true, motivo: 'No volver (Hoteles)', u };
  if (est === 'esperar') return { fuera: true, motivo: 'En espera (Hoteles)', u };
  if (s.proxima_visita && (!u || s.proxima_visita > u.fecha)) return { fecha: s.proxima_visita, motivo: 'fecha fijada por Hoteles', u };
  if (u && u.volver === 'no') return { fuera: true, motivo: 'No volver (visita ' + fmtFecha(u.fecha) + ')', u };
  if (u && volverDe(u.volver)) {
    const dias = volverDe(u.volver)[2] || Number(s.cadencia_dias) || 180;
    return { fecha: addDias(u.fecha, dias), motivo: volverDe(u.volver)[1].toLowerCase(), u };
  }
  if (u) return { fecha: addDias(u.fecha, Number(s.cadencia_dias) || CAD_DEF), motivo: 'cada ' + (Number(s.cadencia_dias) || CAD_DEF) + ' días', u };
  return { pendiente: true, motivo: 'sin visitar', u };
}
const toca = p => !p.fuera && (p.pendiente || p.fecha <= hoyISO());
function textoPlan(p) {
  if (p.fuera) return p.motivo;
  if (p.pendiente) return 'Sin visitar';
  const d = diasEntre(hoyISO(), p.fecha);
  if (d < 0) return `Tocaba el ${fmtFecha(p.fecha)} (hace ${-d} día${d === -1 ? '' : 's'})`;
  if (d === 0) return 'Toca hoy';
  return `Próxima: ${fmtFecha(p.fecha)} (en ${d} día${d === 1 ? '' : 's'})`;
}
/* PMG% del mes cerrado anterior (marcados ÷ pedidos). Viene de pmg_efectividad (número 0-100, o fracción 0-1 si la celda
   tenía formato %) o, si existe, de pmg_efect_mes_ant (texto ya montado). Vacío = hotel sin pacto → no se muestra. */
function pmgMesAnt(s) {
  if (s.pmg_efect_mes_ant) return String(s.pmg_efect_mes_ant);
  const v = s.pmg_efectividad;
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
  const n = Number(v) <= 1 && Number(v) > 0 ? Number(v) * 100 : Number(v);
  return n.toLocaleString('es-ES', { maximumFractionDigits: 1 }) + '%';
}
const prioTag = s => s.prioridad ? `<span class="prio p${esc(s.prioridad)}">${esc(s.prioridad)}</span>` : '';

function visitadosSet() { return new Set(visitas().map(v => v.sitio_id)); }

/* contacto vigente: el último tel/email capturado en visita manda sobre el del maestro */
function contacto(s) {
  const vs = visitasDe(s.id);
  const tel = vs.find(v => v.telefono_nuevo);
  const em = vs.find(v => v.email_nuevo);
  return {
    telefono: tel ? tel.telefono_nuevo : s.telefono, telNuevo: tel || null,
    email: em ? em.email_nuevo : s.email, emailNuevo: em || null
  };
}
function fmtTel(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return { txt: '', ext: false };
  if (d.length <= 6) return { txt: d, ext: true };
  return { txt: d.length === 9 ? d.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3') : String(t), ext: false };
}

/* ───────── sincronización ───────── */
async function sync({ silent = false } = {}) {
  if (syncing || !queue.length || !navigator.onLine) { renderSync(); return; }
  syncing = true; renderSync();
  try {
    const j = await call('sync', { visitas: queue });
    const okIds = new Set(j.resultados.filter(r => r.ok).map(r => r.id));
    const errs = j.resultados.filter(r => !r.ok);
    queue = queue.filter(v => !okIds.has(v.id));
    ls.set(LS.queue, queue);
    data.visitas = j.visitas; ls.set(LS.data, data);
    syncError = errs.length ? errs.map(e => e.error).join('; ') : '';
    if (!silent && okIds.size) toast(`✓ ${okIds.size} visita${okIds.size > 1 ? 's' : ''} enviada${okIds.size > 1 ? 's' : ''}`);
    if (syncError) toast('Error: ' + syncError, 5000);
  } catch (e) {
    syncError = e.server ? e.message : '';
    if (!silent) toast(e.server ? 'Error: ' + e.message : 'Sin conexión. Se enviará luego.');
  } finally {
    syncing = false; renderSync(); rerender();
  }
}
function renderSync() {
  const b = $('#btnSync');
  if (!auth) { b.hidden = true; return; }
  b.hidden = !queue.length && navigator.onLine;
  b.className = 'sync' + (queue.length ? ' pend' : '') + (navigator.onLine ? '' : ' off');
  b.textContent = syncing ? 'Enviando…' : queue.length ? `⇅ ${queue.length} sin enviar` : 'Sin red';
  const ban = $('#banner');
  ban.hidden = !(DEMO || syncError);
  ban.textContent = DEMO ? 'MODO DEMO · datos de prueba, no se envía nada' : syncError ? '⚠ ' + syncError : '';
}
window.addEventListener('online', () => sync());
window.addEventListener('offline', renderSync);
setInterval(() => { if (queue.length) sync({ silent: true }); }, 60000);
$('#btnSync').onclick = () => sync();

async function refresh({ silent = false } = {}) {
  if (!navigator.onLine && !DEMO) { if (!silent) toast('Sin conexión'); return; }
  try {
    const j = await call('bootstrap');
    data = { sitios: j.sitios, paquetes: j.paquetes, visitas: j.visitas, usuarios: j.usuarios, ts: j.ts };
    auth = { ...auth, ...j.user }; ls.set(LS.auth, auth);
    ls.set(LS.data, data);
    if (!silent) toast('Datos actualizados');
    rerender();
  } catch (e) {
    if (e.server && /PIN/.test(e.message)) { logout(); toast(e.message); return; }
    if (!silent) toast(e.server ? 'Error: ' + e.message : 'Sin conexión');
  }
}

function logout() {
  if (queue.length && !confirmSalida()) return;
  auth = null; data = null; ls.del(LS.auth); ls.del(LS.data);
  location.hash = '#/'; route();
}
function confirmSalida() { return window.confirm(`Hay ${queue.length} visita(s) sin enviar. Si sales se perderán. ¿Salir igualmente?`); }

/* ───────── cabecera / menú ───────── */
function header(title, back) {
  $('#title').textContent = title;
  const b = $('#btnBack'); b.hidden = !back; b.onclick = () => { location.hash = back; };
  $('#btnMenu').hidden = !auth;
  $('#menuPanel').hidden = !auth?.admin;
  renderSync();
}
$('#btnMenu').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
$('#menu').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $('#menu').hidden = true;
  if (b.dataset.go) location.hash = b.dataset.go;
});
$('#btnRefresh').onclick = () => { sync({ silent: true }).then(() => refresh()); };
$('#btnLogout').onclick = logout;

/* copiar al tocar */
view.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]'); if (!c) return;
  const txt = c.dataset.copy;
  (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => toast('Copiado: ' + txt), () => {});
});

function tabs(activo) {
  const n = colaHoy(filtroHoyMios()).length;
  return `<div class="seg tabs main" id="tabsMain">
    <button data-go="#/hoy" class="${activo === 'hoy' ? 'on' : ''}">Hoy toca${n ? ` <b class="badge">${n}</b>` : ''}</button>
    <button data-go="#/paquetes" class="${activo === 'paq' ? 'on' : ''}">Paquetes</button>
  </div>`;
}
view.addEventListener('click', e => { const b = e.target.closest('#tabsMain button'); if (b) location.hash = b.dataset.go; });

/* ───────── router ───────── */
function route() {
  window.scrollTo(0, 0);
  if (!auth) return vLogin();
  if (!data) { vCargando(); return refresh({ silent: true }); }
  const [, r, a, b] = (location.hash || '#/').split('/').map(decodeURIComponent);
  switch (r) {
    case 'paquete': return vPaquete(a);
    case 'sitio': return vSitio(a);
    case 'visita': return vForm(a, b);
    case 'panel': return auth.admin ? vPanel() : vHoy();
    case 'paquetes': return vPaquetes();
    default: return vHoy();
  }
}
window.addEventListener('hashchange', route);

/* repintado tras sync/refresh en segundo plano: no pisa un formulario ni lo que se está escribiendo */
function rerender() {
  if (/^#\/visita/.test(location.hash)) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value) return;
  const y = window.scrollY; route(); window.scrollTo(0, y);
}

function vCargando() { header('Rondas'); view.innerHTML = '<p class="empty">Cargando datos…</p>'; }

/* ───────── 1 · ENTRAR ───────── */
function vLogin() {
  header('Rondas');
  view.innerHTML = `
  <form id="fLogin" class="card login">
    <p class="brand">Taxi Alicante · Rondas comerciales</p>
    <label>Usuario
      <div class="seg users" id="segUser">
        <button type="button" data-v="1">1 - DANIEL</button><button type="button" data-v="2">2 - JUAN</button><button type="button" data-v="3">3 - JORGE</button>
      </div>
    </label>
    <label>PIN <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" required></label>
    <button class="primary big" type="submit">Entrar</button>
    <p class="muted small" id="loginMsg">${DEMO ? 'Modo demo: PIN 1111 / 2222 / 3333' : ''}</p>
  </form>`;
  let u = '';
  $('#segUser').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    u = b.dataset.v; [...$('#segUser').children].forEach(x => x.classList.toggle('on', x === b));
  };
  $('#fLogin').onsubmit = async e => {
    e.preventDefault();
    const pin = $('#pin').value.trim();
    if (!u) return toast('Elige tu número');
    if (!navigator.onLine && !DEMO) return toast('Hace falta conexión para entrar la primera vez');
    auth = { usuario: u, pin };
    try {
      const j = await call('login');
      auth = { ...auth, ...j.user }; ls.set(LS.auth, auth);
      location.hash = '#/hoy';
      await refresh({ silent: true });
      route();
    } catch (err) {
      auth = null;
      $('#loginMsg').textContent = err.server ? err.message : 'Sin conexión con el servidor';
    }
  };
}

/* ───────── 2a · HOY TOCA ───────── */
function misPaquetes() { return paquetes().filter(p => esMio(p)); }
function filtroHoyMios() { return ls.get(LS.filtroHoy, 'mios') === 'mios' && misPaquetes().length > 0; }
function sitiosBase(mios) {
  const ids = mios ? new Set(misPaquetes().map(p => p.id)) : null;
  return (data.sitios || []).filter(s => !ids || ids.has(s.paquete));
}
function colaHoy(mios) {
  return sitiosBase(mios).map(s => ({ s, p: plan(s) })).filter(x => toca(x.p))
    .sort((a, b) => (PRIO[a.s.prioridad] ?? 3) - (PRIO[b.s.prioridad] ?? 3)
      || (a.p.pendiente ? '0' : a.p.fecha).localeCompare(b.p.pendiente ? '0' : b.p.fecha)
      || (b.s.pedidos_mes_12m || 0) - (a.s.pedidos_mes_12m || 0));
}
function vHoy() {
  volverA = '#/hoy';
  header(`Hola, ${auth.nombre || ''}`);
  const tengo = misPaquetes().length > 0;
  const mios = filtroHoyMios();
  const cola = colaHoy(mios);
  const hoy = hoyISO(), en7 = addDias(hoy, 7);
  const prox = sitiosBase(mios).map(s => ({ s, p: plan(s) }))
    .filter(x => !x.p.fuera && !x.p.pendiente && x.p.fecha > hoy && x.p.fecha <= en7)
    .sort((a, b) => a.p.fecha.localeCompare(b.p.fecha));
  const zonas = [...new Set(cola.map(x => x.s.zona))];
  const item = ({ s, p }) => `<a class="card sitio ${s.situacion === 'cliente' ? 'cli' : 'nuevo'}" href="#/sitio/${s.id}">
      <div class="row"><strong>${prioTag(s)}${esc(s.nombre)}</strong></div>
      <div class="muted small">${esc(TIPOS[s.tipo] || s.tipo)} · ${esc(s.direccion)} · <em>${esc(s.paquete)}</em></div>
      <div class="tag ${p.pendiente ? '' : 'warn'}">${esc(textoPlan(p))}</div>
    </a>`;
  view.innerHTML = `
  ${tabs('hoy')}
  <div class="seg tabs" id="filHoy">
    <button data-v="mios" class="${mios ? 'on' : ''}" ${tengo ? '' : 'disabled'}>Mis paquetes</button>
    <button data-v="todos" class="${mios ? '' : 'on'}">Todos</button>
  </div>
  <p class="muted small legend">${cola.length ? `${cola.length} sitio${cola.length > 1 ? 's' : ''} por visitar · ordenados por prioridad` : ''}</p>
  ${cola.length ? zonas.map(z => `<h2 class="zona">${esc(z)}</h2>${cola.filter(x => x.s.zona === z).map(item).join('')}`).join('')
    : '<p class="empty">✓ No toca ninguna visita hoy</p>'}
  ${prox.length ? `<h2 class="zona">Próximos 7 días (${prox.length})</h2>${prox.map(item).join('')}` : ''}`;
  $('#filHoy').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return; ls.set(LS.filtroHoy, b.dataset.v); vHoy(); };
}

/* ───────── 2b · PAQUETES ───────── */
function vPaquetes() {
  volverA = '#/paquetes';
  header(`Hola, ${auth.nombre || ''}`);
  const filtro = ls.get(LS.filtro, 'mios');
  const vis = visitadosSet();
  let ps = paquetes();
  const mios = ps.filter(p => esMio(p));
  const usarMios = filtro === 'mios' && mios.length;
  if (usarMios) ps = mios;
  const zonas = [...new Set(ps.map(p => p.zona))];

  view.innerHTML = `
  ${tabs('paq')}
  <div class="search"><input id="q" type="search" placeholder="Buscar sitio en todos los paquetes…" autocomplete="off"></div>
  <div id="res"></div>
  <div class="seg tabs" id="fil">
    <button data-v="mios" class="${usarMios ? 'on' : ''}" ${mios.length ? '' : 'disabled'}>Mis paquetes${mios.length ? ` (${mios.length})` : ''}</button>
    <button data-v="todos" class="${usarMios ? '' : 'on'}">Todos (${paquetes().length})</button>
  </div>
  <div id="lista">${zonas.map(z => `
    <h2 class="zona">${esc(z)}</h2>
    ${ps.filter(p => p.zona === z).map(p => {
      const r = p.sitios.filter(enRonda), n = r.length, k = r.filter(s => vis.has(s.id)).length, pc = n ? Math.round(100 * k / n) : 100;
      const t = p.sitios.filter(s => toca(plan(s))).length;
      return `<a class="card pkg ${pc === 100 ? 'hecho' : ''}" href="#/paquete/${encodeURIComponent(p.id)}">
        <div class="row"><strong>${esc(p.id)}</strong>${p.asignado_a ? `<span class="quien">${esc(p.asignado_a)}</span>` : '<span class="quien libre">Sin asignar</span>'}</div>
        <div class="bar"><i style="width:${pc}%"></i></div>
        <div class="row small"><span>${pc === 100 ? '✓ Completado · ' : ''}${k} de ${n} visitados · <b>${pc}%</b></span><span class="${t ? 'pend' : 'muted'}">${t ? `${t} toca${t > 1 ? 'n' : ''}` : ''}</span></div>
      </a>`;
    }).join('')}`).join('')}
  </div>`;

  $('#fil').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return; ls.set(LS.filtro, b.dataset.v); vPaquetes(); };
  const q = $('#q');
  q.oninput = () => {
    const t = norm(q.value.trim());
    $('#lista').hidden = $('#fil').hidden = !!t;
    $('#res').innerHTML = t ? listaSitios((data.sitios || []).filter(s => matchSitio(s, t)).slice(0, 40), true) : '';
  };
}
function esMio(p) {
  const a = norm(p.asignado_a);
  return a && (a === norm(auth.nombre) || a === String(auth.usuario));
}
function matchSitio(s, t) { return norm(`${s.nombre} ${s.direccion} ${s.id} ${s.abonado}`).includes(t); }

function listaSitios(arr, conPaquete) {
  if (!arr.length) return '<p class="empty">Sin resultados</p>';
  return arr.map(s => {
    const u = ultimaVisita(s.id);
    return `<a class="card sitio ${s.situacion === 'cliente' ? 'cli' : 'nuevo'}${s.no_visitar ? ' bloq' : ''}" href="#/sitio/${s.id}">
      <div class="row"><strong>${prioTag(s)}${esc(s.nombre)}</strong>${u ? `<span class="ok">✓ ${fmtFecha(u.fecha)}</span>` : ''}</div>
      <div class="muted small">${esc(TIPOS[s.tipo] || s.tipo)} · ${esc(s.direccion)}${conPaquete ? ` · <em>${esc(s.paquete)}</em>` : ''}</div>
      ${s.sin_recepcion ? '<div class="tag warn">Sin recepción</div>' : ''}
      ${s.no_visitar ? '<div class="tag">No visitar en ronda · lo lleva Jorge</div>' : (() => { const p = plan(s); return `<div class="tag ${toca(p) && !p.pendiente ? 'warn' : ''}">${esc(textoPlan(p))}</div>`; })()}
    </a>`;
  }).join('');
}

/* ───────── 3 · SITIOS DEL PAQUETE ───────── */
function vPaquete(id) {
  const p = paquetes().find(x => x.id === id);
  if (!p) { location.hash = '#/paquetes'; return; }
  header(p.id, '#/paquetes');
  volverA = '#/paquete/' + encodeURIComponent(p.id);
  const vis = visitadosSet();
  const enR = p.sitios.filter(enRonda);
  const k = enR.filter(s => vis.has(s.id)).length;
  view.innerHTML = `
  <div class="search"><input id="q" type="search" placeholder="Buscar en este paquete…" autocomplete="off"></div>
  <p class="muted small legend"><span class="dot cli"></span>Cliente <span class="dot nuevo"></span>Nuevo · ${k}/${enR.length} visitados${p.asignado_a ? ' · ' + esc(p.asignado_a) : ''}</p>
  <div id="lista">${listaSitios(p.sitios)}</div>`;
  $('#q').oninput = e => {
    const t = norm(e.target.value.trim());
    $('#lista').innerHTML = listaSitios(t ? p.sitios.filter(s => matchSitio(s, t)) : p.sitios);
  };
}

/* ───────── 4 · FICHA DEL SITIO ───────── */
function vSitio(id) {
  const s = sitio(id);
  if (!s) { location.hash = '#/paquetes'; return; }
  header(s.nombre, volverA || '#/paquete/' + encodeURIComponent(s.paquete));
  const c = contacto(s);
  const tel = fmtTel(c.telefono);
  const vs = visitasDe(s.id);
  const si = b => b ? '<b class="yes">Sí</b>' : '<b class="no">No</b>';
  const pl = plan(s);
  const reco = s.sin_recepcion
    ? 'Sin recepción: dejar cartel/QR en la entrada o contactar con la gestión. No dejar planos en recepción.'
    : s.recomendacion;

  view.innerHTML = `
  <section class="card ficha">
    <div class="chips">
      <span class="chip ${s.situacion === 'cliente' ? 'cli' : 'nuevo'}">${s.situacion === 'cliente' ? 'CLIENTE' : 'NUEVO'}</span>
      <span class="chip">${esc(TIPOS[s.tipo] || s.tipo)}</span>
      ${s.volumen ? `<span class="chip">Volumen ${esc(s.volumen)}</span>` : ''}
    </div>
    ${s.sin_recepcion ? '<div class="alert">⚠ Sin recepción</div>' : ''}
    ${s.no_visitar ? '<div class="alert gris">⛔ No visitar en ronda · lo lleva Jorge personalmente</div>' : ''}
    <div class="plan ${pl.fuera ? 'fuera' : toca(pl) ? 'toca' : ''}">
      <b>${esc(textoPlan(pl))}</b>${!pl.fuera && !pl.pendiente ? `<span class="muted small"> · ${esc(pl.motivo)}</span>` : ''}
      ${pl.u ? `<div class="small muted">Última visita: ${fmtFecha(pl.u.fecha)} · ${esc(nombreUsuario(pl.u.usuario))}</div>` : ''}
    </div>
    <dl>
      ${s.prioridad || s.estado ? `<dt>Prioridad · Estado</dt><dd>${s.prioridad ? prioTag(s) : ''}${esc(ESTADOS[norm(s.estado)] || s.estado || '—')}</dd>` : ''}
      ${s.contacto ? `<dt>Contacto</dt><dd>${esc(s.contacto)}</dd>` : ''}
      <dt>Dirección</dt><dd data-copy="${esc(s.direccion)}">${esc(s.direccion) || '—'}</dd>
      <dt>Teléfono</dt><dd ${tel.txt ? `data-copy="${esc(tel.txt)}"` : ''}>${tel.txt ? (tel.ext ? `Ext. interna ${esc(tel.txt)}` : esc(tel.txt)) : '<span class="muted">sin dato</span>'}
        ${c.telNuevo ? `<span class="muted small"> · apuntado en visita ${fmtFecha(c.telNuevo.fecha)}</span>` : ''}</dd>
      <dt>Email</dt><dd ${c.email ? `data-copy="${esc(c.email)}"` : ''}>${c.email ? esc(c.email) : '<span class="muted">sin dato</span>'}
        ${c.emailNuevo ? `<span class="muted small"> · apuntado en visita ${fmtFecha(c.emailNuevo.fecha)}</span>` : ''}</dd>
      <dt>¿Tiene Foxtrot?</dt><dd>${si(s.tiene_foxtrot)}</dd>
      <dt>¿Tiene botonera?</dt><dd>${si(s.tiene_botonera)}</dd>
      <dt>PMG / tarifa pactada</dt><dd>${si(s.pacto_pmg)}${s.abonado ? ` <span class="muted small">· abonado ${esc(s.abonado)}</span>` : ''}</dd>
      <dt>Hotel → aeropuerto <span class="muted small">(dato interno de referencia)</span></dt>
        <dd>${s.pmg_precio != null || s.pmg_precio_festivo != null
          ? `Día ${s.pmg_precio != null ? esc(eur(s.pmg_precio)) : '—'} · Festivo/noche ${s.pmg_precio_festivo != null ? esc(eur(s.pmg_precio_festivo)) : '—'}`
          : '<span class="muted">sin dato</span>'}</dd>
      ${pmgMesAnt(s) ? `<dt>PMG% mes ant.</dt><dd>${esc(pmgMesAnt(s))}</dd>` : ''}
      <dt>Pedidos al mes <span class="muted small">(media 12 meses)</span></dt>
        <dd>${s.pedidos_mes_12m != null ? esc(s.pedidos_mes_12m) : '<span class="muted">sin dato</span>'}</dd>
    </dl>
    <div class="reco"><strong>Qué ofrecer</strong><p>${esc(reco) || '—'}</p></div>
  </section>
  ${s.no_visitar && !auth.admin ? '' : `<a class="primary big block" href="#/visita/${s.id}">Registrar visita</a>`}
  <h2 class="zona">Visitas (${vs.length})</h2>
  ${vs.length ? vs.map(v => tarjetaVisita(v)).join('') : '<p class="empty">Aún sin visitas</p>'}`;
}

function tarjetaVisita(v, conSitio) {
  const puedo = String(v.usuario) === String(auth.usuario) || auth.admin;
  const s = conSitio ? sitio(v.sitio_id) : null;
  const items = [
    v.expositor_puesto ? 'expositor puesto' : 'sin expositor',
    v.planos_dejados ? 'planos dejados' : v.planos_tiene ? 'tenía planos' : 'sin planos',
    v.tarjetas_dejadas ? 'tarjetas dejadas' : v.tarjetas_tiene ? 'tenía tarjetas' : 'sin tarjetas',
    v.boligrafos_dados ? `${v.boligrafos_dados} bolis` : ''
  ].filter(Boolean).join(' · ');
  return `<div class="card visita">
    <div class="row"><strong>${s ? esc(s.nombre) : fmtFecha(v.fecha) + ' ' + esc(v.hora)}</strong>
      <span class="muted small">${s ? fmtFecha(v.fecha) + ' · ' : ''}${esc(nombreUsuario(v.usuario))}${v._pend ? ' · <b class="pend">sin enviar</b>' : ''}</span></div>
    ${v.recibido_por ? `<div class="small">Recibe: ${esc(v.recibido_por)}</div>` : ''}
    <div class="small muted">${items}</div>
    ${v.jorge_contactar ? `<div class="tag ${v.contactado ? '' : 'warn'}">Jorge contacta${v.contactar_motivo ? ': ' + esc(v.contactar_motivo) : ''}${v.contactado ? ' ✓ hecho' : ''}</div>` : ''}
    ${volverDe(v.volver) ? `<div class="small">Volver: <b>${esc(volverDe(v.volver)[1])}</b></div>` : ''}
    ${v.observaciones ? `<p class="small">${esc(v.observaciones)}</p>` : ''}
    ${puedo ? `<a class="small link" href="#/visita/${v.sitio_id}/${encodeURIComponent(v.id)}">Editar</a>` : ''}
  </div>`;
}

/* ───────── 5 · FORMULARIO DE VISITA ───────── */
function vForm(sitioId, visitaId) {
  const s = sitio(sitioId);
  if (!s) { location.hash = '#/paquetes'; return; }
  const prev = visitaId ? visitas().find(v => v.id === visitaId) : null;
  if (visitaId && !prev) { location.hash = '#/sitio/' + sitioId; return; }
  if (prev && String(prev.usuario) !== String(auth.usuario) && !auth.admin) { location.hash = '#/sitio/' + sitioId; return; }
  if (s.no_visitar && !auth.admin) { toast('No visitar en ronda: lo lleva Jorge'); location.hash = '#/sitio/' + sitioId; return; }
  header(prev ? 'Editar visita' : 'Nueva visita', '#/sitio/' + sitioId);

  const v = prev ? { ...prev } : {
    id: uid(), sitio_id: s.id, usuario: auth.usuario, fecha: hoyISO(), hora: horaAhora(),
    recibido_por: '', expositor_puesto: null, planos_tiene: null, planos_dejados: false,
    tarjetas_tiene: null, tarjetas_dejadas: false, boligrafos_dados: 0, jorge_contactar: false,
    contactar_motivo: '', telefono_nuevo: '', email_nuevo: '', observaciones: '', volver: ''
  };
  const c = contacto(s);
  const sinTel = !c.telefono || fmtTel(c.telefono).ext;
  const yn = (k, label, req) => `
    <div class="field"><span>${label}${req ? ' *' : ''}</span>
      <div class="seg yn" data-k="${k}">
        <button type="button" data-v="1" class="${v[k] === true ? 'on' : ''}">Sí</button>
        <button type="button" data-v="0" class="${v[k] === false ? 'on' : ''}">No</button>
      </div></div>`;

  view.innerHTML = `
  <form id="fV" class="card form" novalidate>
    <p class="sitio-n">${esc(s.nombre)}</p>
    <p class="muted small">${esc(nombreUsuario(v.usuario))} (usuario ${esc(v.usuario)})</p>
    <div class="two">
      <label>Fecha <input name="fecha" type="date" value="${esc(v.fecha)}" required></label>
      <label>Hora <input name="hora" type="time" value="${esc(v.hora)}" required></label>
    </div>
    <label>Quién os recibe <input name="recibido_por" value="${esc(v.recibido_por)}" placeholder="Nombre / cargo" autocomplete="off"></label>
    ${yn('expositor_puesto', '¿Tiene expositor puesto?', true)}
    <fieldset><legend>Planos</legend>${yn('planos_tiene', '¿Tiene?', true)}${yn('planos_dejados', '¿Se le dejan?')}</fieldset>
    <fieldset><legend>Tarjetas</legend>${yn('tarjetas_tiene', '¿Tiene?', true)}${yn('tarjetas_dejadas', '¿Se le dejan?')}</fieldset>
    <div class="field"><span>Bolígrafos dados</span>
      <div class="stepper"><button type="button" data-d="-1">−</button>
        <input name="boligrafos_dados" type="number" inputmode="numeric" min="0" max="999" value="${Number(v.boligrafos_dados) || 0}">
        <button type="button" data-d="1">+</button><button type="button" data-d="5">+5</button></div></div>
    <fieldset class="contactar"><legend>¿Quieren PMG / Foxtrot / negociar?</legend>
      ${yn('jorge_contactar', 'Jorge debe contactar')}
      <label id="motivoBox" ${v.jorge_contactar ? '' : 'hidden'}>Motivo <input name="contactar_motivo" value="${esc(v.contactar_motivo)}" maxlength="140" placeholder="Ej.: quieren Foxtrot, preguntan tarifa pactada…"></label>
    </fieldset>
    <label>Teléfono ${sinTel ? '<span class="tag warn">la ficha no lo tiene</span>' : '<span class="muted small">(solo si el de la ficha está mal)</span>'}
      <input name="telefono_nuevo" type="tel" inputmode="tel" value="${esc(v.telefono_nuevo)}" autocomplete="off"></label>
    <label>Email ${c.email ? '<span class="muted small">(solo si el de la ficha está mal)</span>' : '<span class="tag warn">la ficha no lo tiene</span>'}
      <input name="email_nuevo" type="email" inputmode="email" value="${esc(v.email_nuevo)}" autocomplete="off"></label>
    <label>Observaciones <textarea name="observaciones" rows="3">${esc(v.observaciones)}</textarea></label>
    <div class="field" id="fVolver"><span>¿Cuándo volver? *</span>
      <div class="grid3" id="segVolver">${VOLVER.map(([c, t]) => `<button type="button" data-v="${c}" class="${v.volver === c ? 'on' : ''}${c === 'no' ? ' rojo' : ''}">${t}</button>`).join('')}</div></div>
    <button class="primary big" type="submit">Guardar visita</button>
    ${prev ? '<button type="button" class="danger" id="btnDel">Borrar visita</button>' : ''}
  </form>`;

  const f = $('#fV');
  f.querySelectorAll('.yn').forEach(g => g.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    v[g.dataset.k] = b.dataset.v === '1';
    [...g.children].forEach(x => x.classList.toggle('on', x === b));
    g.closest('.field').classList.remove('err');
    if (g.dataset.k === 'jorge_contactar') $('#motivoBox').hidden = !v.jorge_contactar;
  });
  $('#segVolver').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    v.volver = b.dataset.v; [...$('#segVolver').children].forEach(x => x.classList.toggle('on', x === b));
    $('#fVolver').classList.remove('err');
  };
  f.querySelector('.stepper').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const i = f.boligrafos_dados; i.value = Math.max(0, (Number(i.value) || 0) + Number(b.dataset.d));
  };
  const del = $('#btnDel');
  if (del) del.onclick = () => {
    if (!del.dataset.armed) { del.dataset.armed = 1; del.textContent = 'Pulsa otra vez para borrar'; return; }
    guardar({ ...v, borrado: true }, 'Visita borrada');
  };

  f.onsubmit = e => {
    e.preventDefault();
    ['fecha', 'hora', 'recibido_por', 'contactar_motivo', 'telefono_nuevo', 'email_nuevo', 'observaciones']
      .forEach(k => { v[k] = f[k].value.trim(); });
    v.boligrafos_dados = Math.max(0, parseInt(f.boligrafos_dados.value, 10) || 0);
    const faltan = ['expositor_puesto', 'planos_tiene', 'tarjetas_tiene'].filter(k => v[k] !== true && v[k] !== false);
    f.querySelectorAll('.yn').forEach(g => g.closest('.field').classList.toggle('err', faltan.includes(g.dataset.k)));
    if (!v.fecha || !v.hora) return toast('Falta fecha u hora');
    if (faltan.length) return toast('Marca Sí/No en los campos con *');
    if (!volverDe(v.volver)) { $('#fVolver').classList.add('err'); $('#fVolver').scrollIntoView({ block: 'center' }); return toast('Elige cuándo volver'); }
    if (v.email_nuevo && !/^\S+@\S+\.\S+$/.test(v.email_nuevo)) return toast('Email no válido');
    if (!v.jorge_contactar) v.contactar_motivo = '';
    guardar(v, prev ? 'Visita corregida' : 'Visita guardada');
  };
}

function guardar(v, msg) {
  const { _pend, ...limpia } = v;
  queue = queue.filter(x => x.id !== limpia.id).concat(limpia);
  ls.set(LS.queue, queue);
  toast(msg + (navigator.onLine || DEMO ? '' : ' · se enviará al tener red'));
  location.hash = '#/sitio/' + v.sitio_id;
  sync({ silent: true });
}

/* ───────── 6 · PANEL (admin) ───────── */
function vPanel() {
  volverA = '#/panel';
  header('Panel', '#/hoy');
  const vs = visitas();
  const vis = visitadosSet();
  const sitios = (data.sitios || []).filter(enRonda);
  const pc = (k, n) => n ? Math.round(100 * k / n) : 0;
  const total = sitios.length, k = sitios.filter(s => vis.has(s.id)).length;
  const zonas = [...new Set(sitios.map(s => s.zona))].map(z => {
    const ss = sitios.filter(s => s.zona === z); const kk = ss.filter(s => vis.has(s.id)).length;
    return { z, n: ss.length, k: kk };
  });
  const users = (data.usuarios || []).map(u => {
    const mv = vs.filter(v => String(v.usuario) === String(u.usuario));
    return { ...u, nv: mv.length, ns: new Set(mv.map(v => v.sitio_id)).size, ult: mv.map(v => v.fecha).sort().pop() };
  });
  const pend = vs.filter(v => v.jorge_contactar && !v.contactado).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const corr = vs.filter(v => v.telefono_nuevo || v.email_nuevo).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const ult = [...vs].sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora)).slice(0, 15);
  const sinExp = vs.filter(v => !v.exportado || v.exportado === 'MODIFICADA').length;
  const nombres = (data.usuarios || []).map(u => u.nombre);

  view.innerHTML = `
  <section class="card">
    <div class="kpis"><div><b>${pc(k, total)}%</b><span>visitado</span></div><div><b>${colaHoy(false).length}</b><span>tocan hoy</span></div><div><b>${vs.length}</b><span>visitas</span></div></div>
    <h3>Por zona</h3>
    ${zonas.map(z => `<div class="row small"><span>${esc(z.z)}</span><span>${z.k}/${z.n} · ${pc(z.k, z.n)}%</span></div><div class="bar thin"><i style="width:${pc(z.k, z.n)}%"></i></div>`).join('')}
    <h3>Por usuario</h3>
    ${users.map(u => { const ps = paquetes().filter(p => norm(p.asignado_a) === norm(u.nombre)); const ids = new Set(ps.map(p => p.id));
      const t = (data.sitios || []).filter(s => ids.has(s.paquete) && toca(plan(s))).length;
      return `<div class="row small"><span>${esc(u.usuario)} · ${esc(u.nombre)}</span><span>${u.nv} visitas${u.ult ? ' · últ. ' + fmtFecha(u.ult) : ''} · <b>${t} tocan</b></span></div>`; }).join('')}
  </section>

  <h2 class="zona">Jorge debe contactar (${pend.length})</h2>
  ${pend.length ? pend.map(v => { const s = sitio(v.sitio_id) || {}; const c = contacto(s.id ? s : { id: v.sitio_id });
    return `<div class="card visita">
      <div class="row"><a href="#/sitio/${v.sitio_id}"><strong>${esc(s.nombre || v.sitio_id)}</strong></a><span class="muted small">${fmtFecha(v.fecha)} · ${esc(nombreUsuario(v.usuario))}</span></div>
      <div class="small">${esc(v.contactar_motivo) || '<span class="muted">sin motivo</span>'}</div>
      <div class="small muted">${[fmtTel(c.telefono).txt, c.email, v.recibido_por && 'Recibe: ' + v.recibido_por].filter(Boolean).map(esc).join(' · ')}</div>
      <button class="small-btn" data-hecho="${esc(v.id)}">Marcar contactado</button>
    </div>`; }).join('') : '<p class="empty">Nada pendiente</p>'}

  <h2 class="zona">Exportar al DIARIO</h2>
  <section class="card">
    <p class="small">${sinExp} visita(s) sin exportar. Descarga un CSV y copia las filas para pegar en el DIARIO. Tipo de contacto: VISITA PRESENCIAL.</p>
    <button class="primary" id="btnExp" ${sinExp ? '' : 'disabled'}>Exportar nuevas y marcarlas</button>
    <button class="secondary" id="btnExpAll">Re-exportar todo (sin marcar)</button>
    <textarea id="expOut" rows="4" readonly hidden></textarea>
  </section>

  <h2 class="zona">Teléfonos / emails capturados (${corr.length})</h2>
  <section class="card">
    <p class="small muted">Para pasar a COMERCIAL - hoteles y que los integre en el maestro.</p>
    ${corr.slice(0, 30).map(v => `<div class="row small"><span>${esc(v.sitio_id)} · ${esc(sitio(v.sitio_id)?.nombre || '')}</span><span>${esc([v.telefono_nuevo, v.email_nuevo].filter(Boolean).join(' · '))}</span></div>`).join('') || '<p class="empty">Ninguno</p>'}
    ${corr.length ? '<button class="secondary" id="btnCorr">Descargar CSV para Hoteles</button>' : ''}
  </section>

  <h2 class="zona">Asignar paquetes</h2>
  <section class="card">
    ${paquetes().map(p => `<div class="row small asig"><span>${esc(p.id)}</span>
      <select data-paq="${esc(p.id)}"><option value="">—</option>${nombres.map(n => `<option ${n === p.asignado_a ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`).join('')}
  </section>

  <h2 class="zona">Últimas visitas</h2>
  ${ult.map(v => tarjetaVisita(v, true)).join('') || '<p class="empty">Aún sin visitas</p>'}

  <h2 class="zona">Maestro de sitios</h2>
  <section class="card">
    <p class="small">Actual: ${(data.sitios || []).length} sitios (${total} en ronda) · ${paquetes().length} paquetes. Cada carga reemplaza el maestro entero; las visitas se conservan (van por ID).</p>
    <label class="small">Pega el enlace de la hoja maestra nueva (RONDAS – SITIOS vX)
      <input id="maestroUrl" type="url" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
    <button class="primary" id="btnMaestro">Cargar desde la hoja</button>
    <p class="small muted">O desde un JSON:</p>
    <input type="file" id="seedFile" accept=".json,application/json">
  </section>`;

  view.querySelectorAll('[data-hecho]').forEach(b => b.onclick = () => online(async () => {
    const j = await call('contactado', { id: b.dataset.hecho, valor: true });
    data.visitas = j.visitas; ls.set(LS.data, data); toast('Marcado'); vPanel();
  }));
  view.querySelectorAll('[data-paq]').forEach(sel => sel.onchange = () => online(async () => {
    const j = await call('asignar', { paquete: sel.dataset.paq, asignado_a: sel.value });
    data.paquetes = j.paquetes; ls.set(LS.data, data); toast('Asignado');
  }));
  const exp = (marcar, todas) => online(async () => {
    if (queue.length) await sync({ silent: true });
    const j = await call('exportar', { marcar, todas });
    if (!j.filas.length) return toast('No hay visitas que exportar');
    const cols = ['FECHA VISITA', 'VISITADOR', 'CLIENTE', 'TELÉFONO', 'TIPO CONTACTO', 'ACTUACIÓN REALIZADA', 'PRÓXIMO PASO', 'OBSERVACIONES'];
    descargarCSV(`VISITAS_DIARIO_${hoyISO()}.csv`, cols, j.filas);
    const tsv = j.filas.map(f => cols.map(c => String(f[c] ?? '').replace(/[\t\n\r]+/g, ' ')).join('\t')).join('\n');
    const o = $('#expOut'); o.hidden = false; o.value = tsv; o.select();
    navigator.clipboard?.writeText(tsv).then(() => toast(`${j.filas.length} filas copiadas · pégalas en el DIARIO`), () => {});
    const corregidas = j.filas.filter(f => f._rev).length;
    if (corregidas) toast(`${corregidas} son correcciones de visitas ya exportadas: revisa en el DIARIO`, 6000);
    if (marcar) { await refresh({ silent: true }); }
  });
  $('#btnExp').onclick = () => exp(true, false);
  $('#btnExpAll').onclick = () => exp(false, true);
  const bc = $('#btnCorr');
  if (bc) bc.onclick = () => descargarCSV(`CONTACTOS_CAPTURADOS_${hoyISO()}.csv`, ['id', 'nombre', 'telefono_nuevo', 'email_nuevo', 'fecha', 'visitador'],
    corr.map(v => ({ id: v.sitio_id, nombre: sitio(v.sitio_id)?.nombre || '', telefono_nuevo: v.telefono_nuevo, email_nuevo: v.email_nuevo, fecha: v.fecha, visitador: nombreUsuario(v.usuario) })));
  $('#btnMaestro').onclick = () => online(async () => {
    const url = $('#maestroUrl').value.trim();
    if (!url) return toast('Pega el enlace de la hoja');
    if (!window.confirm('Reemplazar el maestro actual por esa hoja?')) return;
    const j = await call('cargarMaestro', { url });
    toast(`Maestro cargado: ${j.total} sitios`); await refresh({ silent: true });
  });
  $('#seedFile').onchange = e => online(async () => {
    const file = e.target.files[0]; if (!file) return;
    let seed; try { seed = JSON.parse(await file.text()); } catch { return toast('JSON no válido'); }
    const n = (seed.sitios || seed).length;
    if (!window.confirm(`Cargar ${n} sitios y reemplazar el maestro actual (${total})?`)) return;
    const j = await call('cargarSeed', { seed });
    toast(`Maestro cargado: ${j.total} sitios`); await refresh({ silent: true });
  });
}

async function online(fn) {
  if (!navigator.onLine && !DEMO) return toast('Necesitas conexión');
  try { await fn(); } catch (e) { toast('Error: ' + e.message, 5000); }
}

function descargarCSV(nombre, cols, filas) {
  const q = x => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [cols.map(q).join(';'), ...filas.map(f => cols.map(c => q(f[c])).join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
}

/* ───────── MODO DEMO (sin backend; solo pruebas locales) ───────── */
async function demo(action, body) {
  const K = 'rondas_demo_srv';
  let srv = ls.get(K, null);
  if (!srv) {
    let sitios = [];
    try { const r = await fetch('sitios_seed.json'); sitios = (await r.json()).sitios; } catch {}
    srv = { sitios, visitas: [], asig: {}, usuarios: [
      { usuario: '1', nombre: 'DANIEL', pin: '1111', admin: false },
      { usuario: '2', nombre: 'JUAN', pin: '2222', admin: false },
      { usuario: '3', nombre: 'JORGE', pin: '3333', admin: true }] };
  }
  const save = () => ls.set(K, srv);
  const u = srv.usuarios.find(x => x.usuario === String(auth?.usuario) && x.pin === String(auth?.pin));
  const fail = m => { const e = new Error(m); e.server = true; throw e; };
  if (!u) fail('Usuario o PIN incorrecto');
  const user = { usuario: u.usuario, nombre: u.nombre, admin: u.admin };
  const paqs = () => [...new Map(srv.sitios.map(s => [s.paquete, { id: s.paquete, zona: s.zona, asignado_a: srv.asig[s.paquete] || '' }])).values()];
  const vivas = () => srv.visitas.filter(v => !v.borrado);
  switch (action) {
    case 'login': return { ok: true, user };
    case 'bootstrap': save(); return { ok: true, user, sitios: srv.sitios, paquetes: paqs(), visitas: vivas(),
      usuarios: srv.usuarios.map(x => ({ usuario: x.usuario, nombre: x.nombre })), ts: new Date().toISOString() };
    case 'sync': {
      const res = body.visitas.map(v => {
        const i = srv.visitas.findIndex(x => x.id === v.id);
        if (i >= 0) {
          if (srv.visitas[i].usuario !== user.usuario && !user.admin) return { id: v.id, ok: false, error: 'Solo puedes editar tus visitas' };
          srv.visitas[i] = { ...v, usuario: srv.visitas[i].usuario, contactado: srv.visitas[i].contactado, exportado: srv.visitas[i].exportado ? 'MODIFICADA' : '' };
        } else if (!v.borrado) srv.visitas.push({ ...v, usuario: user.usuario, exportado: '' });
        return { id: v.id, ok: true };
      });
      save(); return { ok: true, resultados: res, visitas: vivas() };
    }
    case 'asignar': srv.asig[body.paquete] = body.asignado_a; save(); return { ok: true, paquetes: paqs() };
    case 'contactado': srv.visitas.find(v => v.id === body.id).contactado = body.valor; save(); return { ok: true, visitas: vivas() };
    case 'cargarSeed': srv.sitios = body.seed.sitios || body.seed; save(); return { ok: true, total: srv.sitios.length };
    case 'exportar': {
      const filas = vivas().filter(v => body.todas || !v.exportado || v.exportado === 'MODIFICADA').map(v => {
        const s = srv.sitios.find(x => x.id === v.sitio_id) || {};
        const f = v.fecha.split('-');
        const act = ['Expositor ' + (v.expositor_puesto ? 'puesto' : 'NO puesto'), v.planos_dejados ? 'planos dejados' : !v.planos_tiene ? 'sin planos' : '',
          v.tarjetas_dejadas ? 'tarjetas dejadas' : !v.tarjetas_tiene ? 'sin tarjetas' : '', v.boligrafos_dados ? v.boligrafos_dados + ' bolis' : ''].filter(Boolean).join(', ');
        const row = { 'FECHA VISITA': `${f[2]}/${f[1]}/${f[0]}`, 'VISITADOR': srv.usuarios.find(x => x.usuario === v.usuario)?.nombre, 'CLIENTE': s.nombre,
          'TELÉFONO': v.telefono_nuevo || s.telefono || '', 'TIPO CONTACTO': 'VISITA PRESENCIAL', 'ACTUACIÓN REALIZADA': act,
          'PRÓXIMO PASO': [v.jorge_contactar ? 'Jorge contacta: ' + (v.contactar_motivo || '') : '', volverDe(v.volver) ? 'Volver: ' + volverDe(v.volver)[1] : ''].filter(Boolean).join(' · '),
          'OBSERVACIONES': [v.recibido_por && 'Recibe: ' + v.recibido_por, v.email_nuevo && 'Email: ' + v.email_nuevo, v.observaciones].filter(Boolean).join(' · '),
          _rev: v.exportado === 'MODIFICADA' ? 'CORREGIDA' : '' };
        if (body.marcar) v.exportado = hoyISO();
        return row;
      });
      save(); return { ok: true, filas };
    }
  }
  fail('Acción desconocida');
}

/* ───────── arranque ───────── */
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
route();
if (auth && data) { sync({ silent: true }).then(() => refresh({ silent: true })); }
})();
