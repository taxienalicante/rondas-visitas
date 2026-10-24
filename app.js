/* RONDAS COMERCIALES · PWA · Sistema RTT · v1.8 2026-10-22 */
(() => {
'use strict';

const APP_V = '1.8.4';
const API = (window.RONDAS_API || '').trim();
const DEMO = !API;
const LS = { auth: 'rondas_auth', data: 'rondas_data', queue: 'rondas_queue', vista: 'rondas_vista', quien: 'rondas_visitas_quien', filtroT: 'rondas_filtro_t', zonas: 'rondas_zonas_abiertas' };
const TIPOS = { hotel: 'Hotel', clinica: 'Clínica', residencia: 'Residencia', negocio: 'Negocio', ambulatorio: 'Ambulatorio', restaurante: 'Restaurante', otro: 'Otro' };

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
let volverA = '';
let lastRefresh = 0;   // lista desde la que se abrió la ficha (Hoy, paquete, panel)

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
let _idx = { d: null, q: null, all: [], por: new Map() };   // índice por sitio (se rehace solo si cambian datos o cola)
function indice() {
  if (_idx.d === data?.visitas && _idx.q === queue) return _idx;
  const m = new Map((data?.visitas || []).map(v => [v.id, v]));
  queue.forEach(v => m.set(v.id, { ...v, _pend: true }));
  const all = [...m.values()].filter(v => !v.borrado);
  const por = new Map();
  all.forEach(v => { if (!por.has(v.sitio_id)) por.set(v.sitio_id, []); por.get(v.sitio_id).push(v); });
  por.forEach(a => a.sort((x, y) => (y.fecha + y.hora).localeCompare(x.fecha + x.hora)));
  _idx = { d: data?.visitas, q: queue, all, por };
  return _idx;
}
function visitas() { return indice().all; }
function visitasDe(sitioId) { return indice().por.get(sitioId) || []; }
function ultimaVisita(sitioId) { return visitasDe(sitioId)[0] || null; }
function sitio(id) { return (data?.sitios || []).find(s => s.id === id); }
const enRonda = s => !s.no_visitar;   // no_visitar = lo lleva Jorge: fuera del % y del punteo
/* ───────── sistema vivo: cuándo toca cada sitio ───────── */
/* "¿Cuándo volver?" es texto libre del comercial: solo sugerencia. Los códigos de la v1.3 (2s, 1m…) se tratan como vacíos. */
const CODIGOS_V13 = ['2s', '1m', '3m', '6m', 'fiel', 'no'];
const sugerencia = v => { const t = String(v?.volver || '').trim(); return CODIGOS_V13.includes(t) ? '' : t; };
const CAD_DEF = 90;   // si no hay fecha fijada ni cadencia
const fijada = id => (data?.proximas || []).find(x => x.sitio_id === id)?.fecha || '';
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const PRIO = { 'A+': 0, A: 1, B: 2, C: 3 };
const ESTADOS = { 'pendiente': 'Pendiente', 'en seguimiento': 'En seguimiento', 'cliente ok': 'Cliente OK', 'no volver': 'No volver', 'esperar': 'Esperar' };

/* Reglas (gana la primera): no_visitar / estado no volver / esperar → fuera · fecha fijada por Jorge posterior a la última
   visita · proxima_visita del maestro posterior a la última visita · última visita + cadencia (90) · sin visitas → toca ya */
function plan(s) {
  const u = ultimaVisita(s.id);
  const est = norm(s.estado);
  if (s.no_visitar) return { fuera: true, motivo: 'Lo lleva Jorge', u };
  if (est === 'no volver') return { fuera: true, motivo: 'No volver (Hoteles)', u };
  if (est === 'esperar') return { fuera: true, motivo: 'En espera (Hoteles)', u };
  const fj = fijada(s.id);
  if (fj && (!u || fj > u.fecha)) return { fecha: fj, motivo: 'fecha fijada por Jorge', fijadaJorge: true, u };
  if (s.proxima_visita && (!u || s.proxima_visita > u.fecha)) return { fecha: s.proxima_visita, motivo: 'fecha fijada por Hoteles', u };
  if (u) return { fecha: addDias(u.fecha, Number(s.cadencia_dias) || CAD_DEF), motivo: 'cada ' + (Number(s.cadencia_dias) || CAD_DEF) + ' días (sin fecha fijada)', sinFijar: true, u };
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
  if (!s.pacto_pmg) return '';
  if (s.pmg_efect_mes_ant) return String(s.pmg_efect_mes_ant);
  const v = s.pmg_efectividad;
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '';
  const n = Number(v) <= 1 && Number(v) > 0 ? Number(v) * 100 : Number(v);
  return n.toLocaleString('es-ES', { maximumFractionDigits: 1 }) + '%';
}
/* ───────── sitios nuevos encontrados en la calle (visita con sitio_nuevo, id provisional NUEVO-xxxxx) ───────── */
const TIPOS_NUEVO = [['hotel', 'Hotel'], ['clinica', 'Clínica'], ['residencia', 'Residencia'], ['restaurante', 'Restaurante'], ['negocio', 'Negocio / empresa'], ['otro', 'Otro']];
const esNuevoId = id => /^NUEVO-/.test(String(id || ''));
const idNuevo = () => 'NUEVO-' + Math.random().toString(36).slice(2, 7).toUpperCase();
function pseudoSitio(id) {   // ficha mínima a partir de la última visita del sitio nuevo
  const v = visitas().filter(x => x.sitio_id === id).sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora))[0];
  if (!v) return null;
  return { id, nuevo: true, nombre: v.nuevo_nombre || 'Sitio nuevo', direccion: v.nuevo_direccion || '', tipo: v.nuevo_tipo || 'otro',
    telefono: v.nuevo_telefono || '', email: '', paquete: '', zona: '', situacion: 'nuevo', recomendacion: '' };
}
const nombreSitio = id => sitio(id)?.nombre || pseudoSitio(id)?.nombre || id;
const btnNuevo = () => `<div class="acciones"><a class="nuevo-btn" href="#/visita/nuevo">➕ Sitio nuevo</a><a class="nuevo-btn mis" href="#/visitas">📋 Visitas</a></div>`;

const prioCls = p => ({ 'A+': 'pAp', A: 'pA', B: 'pB', C: 'pC' }[p] || '');
const prioTag = s => PRIO[s.prioridad] !== undefined ? `<span class="prio ${prioCls(s.prioridad)}">${esc(s.prioridad)}</span>` : '';
const prioClase = s => PRIO[s.prioridad] !== undefined ? 'pr-' + prioCls(s.prioridad) : '';
/* "J": hay una visita con "Jorge debe contactar" sin marcar como contactada (independiente de la prioridad) */
const pendJ = id => visitasDe(id).filter(v => v.jorge_contactar && !v.contactado);
const jTag = id => pendJ(id).length ? '<span class="jbadge" title="Jorge debe contactar">J</span>' : '';

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

/* ───────── fotos: se comprimen en el móvil, esperan en IndexedDB y suben cuando la visita ya está en el servidor ───────── */
let fotosCola = [];        // copia en memoria de lo pendiente (para contar y pintar)
const fotosMem = new Map(); // respaldo si el navegador no deja usar IndexedDB
const fotosStore = (() => {
  let dbp = null;
  const abrir = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('rondas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fotos', { keyPath: 'foto_id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = (modo, fn) => abrir().then(db => new Promise((res, rej) => {
    const t = db.transaction('fotos', modo); const rq = fn(t.objectStore('fotos'));
    t.oncomplete = () => res(rq.result); t.onerror = () => rej(t.error);
  }));
  return {
    put: f => tx('readwrite', st => st.put(f)).catch(() => { fotosMem.set(f.foto_id, f); }),
    del: id => { fotosMem.delete(id); return tx('readwrite', st => st.delete(id)).catch(() => {}); },
    all: () => tx('readonly', st => st.getAll()).catch(() => []).then(a => [...(a || []), ...fotosMem.values()])
  };
})();
async function cargarFotosCola() { fotosCola = (await fotosStore.all()).map(({ data: _d, ...x }) => x); renderSync(); }
async function comprimir(file, max = 1600, q = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}
async function subirFotos() {
  const todas = await fotosStore.all();
  const enCola = new Set(queue.map(v => v.id));
  let ok = 0;
  for (const f of todas) {
    if (enCola.has(f.visita_id)) continue;                       // la visita aún no ha llegado al servidor
    const v = (data?.visitas || []).find(x => x.id === f.visita_id);
    if (!v && !DEMO) { if (Date.now() - (f.creado || 0) > 7 * 864e5) await fotosStore.del(f.foto_id); continue; }   // visita borrada
    try {
      const j = await call('subirFoto', { foto_id: f.foto_id, visita_id: f.visita_id, data: f.data });
      await fotosStore.del(f.foto_id); ok++;
      const vv = (data?.visitas || []).find(x => x.id === f.visita_id);
      if (vv && !String(vv.fotos || '').split(',').includes(j.file_id)) vv.fotos = [vv.fotos, j.file_id].filter(Boolean).join(',');
    } catch (e) { if (!e.server) break; syncError = 'Foto: ' + e.message; }
  }
  if (ok) { ls.set(LS.data, data); _idx.d = null; }
  await cargarFotosCola();
  return ok;
}

/* ───────── sincronización ───────── */
async function sync({ silent = false } = {}) {
  if (syncing || (!queue.length && !fotosCola.length) || (!navigator.onLine && !DEMO)) { renderSync(); return; }
  syncing = true; renderSync();
  try {
    if (queue.length) {
      const j = await call('sync', { visitas: queue });
      const okIds = new Set(j.resultados.filter(r => r.ok).map(r => r.id));
      const errs = j.resultados.filter(r => !r.ok);
      queue = queue.filter(v => !okIds.has(v.id));
      ls.set(LS.queue, queue);
      data.visitas = j.visitas; ls.set(LS.data, data);
      syncError = errs.length ? errs.map(e => e.error).join('; ') : '';
      if (!silent && okIds.size) toast(`✓ ${okIds.size} visita${okIds.size > 1 ? 's' : ''} enviada${okIds.size > 1 ? 's' : ''}`);
      if (syncError) toast('Error: ' + syncError, 5000);
    }
    if (fotosCola.length) { const n = await subirFotos(); if (n && !silent) toast(`✓ ${n} foto${n > 1 ? 's' : ''} enviada${n > 1 ? 's' : ''}`); }
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
  const nf = fotosCola.length, pend = queue.length || nf;
  b.hidden = !pend && navigator.onLine;
  b.className = 'sync' + (pend ? ' pend' : '') + (navigator.onLine ? '' : ' off');
  b.textContent = syncing ? 'Enviando…' : pend ? '⇅ ' + [queue.length ? `${queue.length} sin enviar` : '', nf ? `${nf} foto${nf > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') : 'Sin red';
  const ban = $('#banner');
  ban.hidden = !(DEMO || syncError);
  ban.textContent = DEMO ? 'MODO DEMO · datos de prueba, no se envía nada' : syncError ? '⚠ ' + syncError : '';
}
window.addEventListener('online', () => sync());
window.addEventListener('offline', renderSync);
setInterval(() => { if (queue.length || fotosCola.length) sync({ silent: true }); }, 60000);
$('#btnSync').onclick = () => sync();

async function refresh({ silent = false } = {}) {
  if (!navigator.onLine && !DEMO) { if (!silent) toast('Sin conexión'); return; }
  try {
    const j = await call('bootstrap');
    data = { sitios: j.sitios, paquetes: j.paquetes, visitas: j.visitas, usuarios: j.usuarios, proximas: j.proximas || [], geo_nuevos: j.geo_nuevos || [], ts: j.ts };
    lastRefresh = Date.now();
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
  if ((queue.length || fotosCola.length) && !confirmSalida()) return;
  auth = null; data = null; ls.del(LS.auth); ls.del(LS.data);
  location.hash = '#/'; route();
}
function confirmSalida() { return window.confirm(`Hay ${queue.length} visita(s) y ${fotosCola.length} foto(s) sin enviar. Si sales, las visitas se perderán. ¿Salir igualmente?`); }

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

/* ───────── router ───────── */
function route() {
  window.scrollTo(0, 0);
  if (!auth) return vLogin();
  if (!data) { vCargando(); return refresh({ silent: true }); }
  const [, r, a, b] = (location.hash || '#/').split('/').map(decodeURIComponent);
  switch (r) {
    case 'sitio': return vSitio(a);
    case 'visita': return vForm(a, b);
    case 'panel': return auth.admin ? vPanel() : vLista();
    case 'visitas': return vVisitas();
    default: return vLista();   // una sola lista (los paquetes ya no se usan para navegar)
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
      location.hash = '#/';
      await refresh({ silent: true });
      route();
    } catch (err) {
      console.error(err);
      if (!err.server && auth?.usuario && data) { route(); return; }   // ya entró: fallo al pintar, no de login
      auth = null; ls.del(LS.auth);
      const m = $('#loginMsg'); if (m) m.textContent = err.server ? err.message : 'Sin conexión con el servidor'; else route();
    }
  };
}

/* ───────── 2 · LISTA ÚNICA DE SITIOS: vistas Zona / Prioridad / Cerca · filtro Tocan / 7 días / Todos ───────── */
let miPos = null;   // punto de referencia { lat, lng, ts, etq } (solo en memoria): mi ubicación o una calle escrita
let ultCalle = '';
const distKm = (a, b) => {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtDist = d => d < 1 ? Math.round(d * 1000 / 10) * 10 + ' m' : d.toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' km';
const tieneGeo = s => s.lat !== null && s.lat !== undefined && s.lat !== '' && s.lng !== null && s.lng !== undefined && s.lng !== '';
function pedirUbicacion() {
  if (!navigator.geolocation) { toast('Este móvil no da la ubicación'); return Promise.resolve(false); }
  toast('Buscando tu ubicación…', 8000);
  return new Promise(res => navigator.geolocation.getCurrentPosition(
    p => { miPos = { lat: p.coords.latitude, lng: p.coords.longitude, ts: Date.now(), etq: 'tu ubicación' }; toast('Ubicación lista'); res(true); },
    e => { toast(e.code === 1 ? 'Permiso de ubicación denegado: actívalo en el navegador' : 'No se pudo obtener la ubicación'); res(false); },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }));
}
async function buscarCalle(texto) {
  if (!texto) return false;
  if (!navigator.onLine && !DEMO) { toast('Buscar una calle necesita conexión'); return false; }
  try {
    const j = await call('buscarCalle', { texto });
    if (!j.encontrado) { toast('No encuentro esa calle. Prueba con número y municipio.'); return false; }
    miPos = { lat: j.lat, lng: j.lng, ts: Date.now(), etq: j.direccion || texto }; ultCalle = texto; return true;
  } catch (e) { toast(e.server ? 'Error: ' + e.message : 'Sin conexión'); return false; }
}
const GRUPOS_PRIO = [['A+', 'A+ · urgente'], ['A', 'A · importante'], ['B', 'B · seguimiento'], ['C', 'C · mantener'], ['', 'Sin prioridad']];

function vLista() {
  volverA = '#/';
  header(`Hola, ${auth.nombre || ''}`);
  const vista = ls.get(LS.vista, 'zona');
  const filtro = ls.get(LS.filtroT, 'tocan');
  const hoy = hoyISO(), en7 = addDias(hoy, 7);
  const todos = (data.sitios || []).map(s => ({ s, p: plan(s) }));
  const nTocan = todos.filter(x => toca(x.p)).length;
  const enSemana = x => !x.p.fuera && (toca(x.p) || (x.p.fecha && x.p.fecha <= en7));
  const nSemana = todos.filter(enSemana).length;
  const filas = todos.filter(x => filtro === 'todos' || (filtro === 'semana' ? enSemana(x) : toca(x.p)));
  const ordenPlan = (a, b) => (a.p.fuera ? 1 : 0) - (b.p.fuera ? 1 : 0)
    || (a.p.pendiente ? '0' : a.p.fecha || '9').localeCompare(b.p.pendiente ? '0' : b.p.fecha || '9')
    || (b.s.pedidos_mes_12m || 0) - (a.s.pedidos_mes_12m || 0);
  const ordenPrio = (a, b) => (PRIO[a.s.prioridad] ?? 9) - (PRIO[b.s.prioridad] ?? 9) || ordenPlan(a, b);

  let cuerpo = '';
  if (!filas.length) cuerpo = `<p class="empty">${filtro === 'todos' ? 'Sin sitios cargados' : '✓ No toca ninguna visita'}</p>`;
  else if (vista === 'prio') {
    cuerpo = GRUPOS_PRIO.map(([k, t]) => {
      const g = filas.filter(x => (PRIO[x.s.prioridad] !== undefined ? x.s.prioridad : '') === k).sort(ordenPlan);
      return g.length ? `<h2 class="zona">${esc(t)} (${g.length})</h2>${g.map(x => itemSitio(x)).join('')}` : '';
    }).join('');
  } else if (vista === 'cerca') {
    const caja = `<div class="card cerca-box">
      <button class="primary" id="btnUbic" type="button">📍 Usar mi ubicación</button>
      <form id="fCalle" class="fijar"><input id="calle" type="search" placeholder="…o escribe una calle (ej.: Av. Denia 103)" value="${esc(ultCalle)}" autocomplete="off"><button class="small-btn" type="submit">Buscar</button></form>
    </div>`;
    if (!miPos) cuerpo = caja + '<p class="muted small legend">La ubicación solo se usa en el móvil para ordenar; no se guarda.</p>';
    else {
      const con = filas.filter(x => tieneGeo(x.s)).map(x => ({ ...x, d: distKm(miPos, { lat: Number(x.s.lat), lng: Number(x.s.lng) }) })).sort((a, b) => a.d - b.d);
      const sin = filas.filter(x => !tieneGeo(x.s)).sort(ordenPrio);
      cuerpo = `${caja}<p class="muted small legend">Más cercanos a <b>${esc(miPos.etq)}</b>${miPos.etq === 'tu ubicación' ? ` (hace ${Math.max(0, Math.round((Date.now() - miPos.ts) / 60000))} min)` : ''}</p>
        ${con.map(x => itemSitio(x, x.d)).join('')}
        ${sin.length ? `<h2 class="zona">Sin coordenadas (${sin.length})</h2>${sin.map(x => itemSitio(x)).join('')}` : ''}`;
    }
  } else if (vista === 'paq') {
    /* paquetes como antes: asignado, % visitado, verde al completar. Los míos primero. Dentro, los sitios según el filtro. */
    const abiertas = ls.get(LS.zonas, []);
    const vis = visitadosSet();
    const ps = paquetesInfo().sort((a, b) => (esMio(b) ? 1 : 0) - (esMio(a) ? 1 : 0));
    cuerpo = ps.map(p => {
      const r = p.sitios.filter(enRonda), n = r.length, k = r.filter(x => vis.has(x.id)).length, pc = n ? Math.round(100 * k / n) : 100;
      const dentro = filas.filter(x => x.s.paquete === p.id).sort(ordenPrio);
      const nT = p.sitios.filter(x => toca(plan(x))).length, key = 'paq|' + p.id;
      return `<details class="zona-acc paq ${pc === 100 ? 'hecho' : ''}" data-z="${esc(key)}" ${abiertas.includes(key) ? 'open' : ''}>
        <summary><span class="zn">${esc(p.id)}</span><span class="zc">${p.asignado_a ? `<span class="quien${esMio(p) ? ' mio' : ''}">${esc(p.asignado_a)}</span>` : ''}<b>${pc}%</b></span>
          <span class="pbar"><i style="width:${pc}%"></i></span>
          <span class="small muted psub">${pc === 100 ? '✓ Completado · ' : ''}${k} de ${n} visitados${nT ? ` · <span class="pend">${nT} toca${nT > 1 ? 'n' : ''}</span>` : ''}</span></summary>
        ${dentro.length ? dentro.map(x => itemSitio(x, null, true)).join('') : `<p class="empty small">${filtro === 'todos' ? 'Sin sitios' : 'Nada pendiente con este filtro'}</p>`}</details>`;
    }).join('');
  } else {
    const zonas = [...new Set(filas.map(x => x.s.zona || 'Sin zona'))];
    const abiertas = ls.get(LS.zonas, []);
    cuerpo = zonas.map(z => { const g = filas.filter(x => (x.s.zona || 'Sin zona') === z).sort(ordenPrio);
      /* segundo nivel: barrio del maestro (si falta, el paquete). Si la zona tiene un solo barrio, sin segundo nivel. */
      const barrioDe = x => String(x.s.barrio || '').trim() || String(x.s.paquete || '').trim() || 'Sin barrio';
      const barrios = [...new Set(g.map(barrioDe))].sort((a, b) => a.localeCompare(b, 'es'));
      const dentro = barrios.length < 2 ? g.map(x => itemSitio(x, null, true)).join('')
        : barrios.map(bn => { const gb = g.filter(x => barrioDe(x) === bn); const key = z + '|' + bn;
            return `<details class="zona-acc barrio" data-z="${esc(key)}" ${abiertas.includes(key) ? 'open' : ''}>
              <summary>${resumenGrupo(bn, gb, filtro)}</summary>${gb.map(x => itemSitio(x, null, true)).join('')}</details>`; }).join('');
      return `<details class="zona-acc" data-z="${esc(z)}" ${abiertas.includes(z) ? 'open' : ''}>
        <summary>${resumenGrupo(z, g, filtro)}</summary>${dentro}</details>`; }).join('');
  }

  const mias = visitas().filter(v => String(v.usuario) === String(auth.usuario))
    .sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora)).slice(0, 3);
  view.innerHTML = `
  ${btnNuevo()}
  ${mias.length ? `<section class="card ultimas"><div class="row"><b>Tus últimas visitas</b><a class="link" href="#/visitas">Ver todas →</a></div>
    ${mias.map(v => `<div class="row uv"><a href="#/sitio/${esc(v.sitio_id)}"><span>${esc(nombreSitio(v.sitio_id))}</span> <span class="muted small">${fmtFecha(v.fecha)}${v._pend ? ' · <b class="pend">sin enviar</b>' : ''}</span></a>
      <a class="small-btn" href="#/visita/${esc(v.sitio_id)}/${encodeURIComponent(v.id)}" data-desde="inicio">Editar</a></div>`).join('')}</section>` : ''}
  <div class="search"><input id="q" type="search" placeholder="Buscar sitio por nombre, calle o ID…" autocomplete="off"></div>
  <div id="res"></div>
  <div id="lista">
    <div class="seg tabs" id="segVista">
      <button data-v="zona" class="${vista === 'zona' ? 'on' : ''}">Zona</button>
      <button data-v="paq" class="${vista === 'paq' ? 'on' : ''}">Paquetes</button>
      <button data-v="prio" class="${vista === 'prio' ? 'on' : ''}">Prioridad</button>
      <button data-v="cerca" class="${vista === 'cerca' ? 'on' : ''}">📍 Cerca</button>
    </div>
    <div class="seg tabs fil" id="segFiltro">
      <button data-v="tocan" class="${filtro === 'tocan' ? 'on' : ''}">Tocan${nTocan ? ` <b class="badge">${nTocan}</b>` : ''}</button>
      <button data-v="semana" class="${filtro === 'semana' ? 'on' : ''}">7 días (${nSemana})</button>
      <button data-v="todos" class="${filtro === 'todos' ? 'on' : ''}">Todos (${todos.length})</button>
    </div>
    <p class="muted small legend leyenda-prio"><span class="prio pAp">A+</span>urgente <span class="prio pA">A</span>importante <span class="prio pB">B</span>seguimiento <span class="prio pC">C</span>mantener <span class="jbadge">J</span>Jorge contacta</p>
    ${cuerpo}
  </div>`;

  $('#segVista').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    ls.set(LS.vista, b.dataset.v);
    vLista();
  };
  $('#segFiltro').onclick = e => { const b = e.target.closest('button'); if (!b) return; ls.set(LS.filtroT, b.dataset.v); vLista(); };
  view.querySelectorAll('details.zona-acc').forEach(d => d.ontoggle = () => {
    const a = new Set(ls.get(LS.zonas, [])); d.open ? a.add(d.dataset.z) : a.delete(d.dataset.z); ls.set(LS.zonas, [...a]);
  });
  const bu = $('#btnUbic'); if (bu) bu.onclick = async () => { if (await pedirUbicacion()) vLista(); };
  const fc = $('#fCalle'); if (fc) fc.onsubmit = async e => { e.preventDefault(); const t = $('#calle').value.trim(); if (!t) return; toast('Buscando…'); if (await buscarCalle(t)) vLista(); };
  const q = $('#q');
  q.oninput = () => {
    const t = norm(q.value.trim());
    $('#lista').hidden = !!t;
    const r = t ? (data.sitios || []).filter(s => matchSitio(s, t)).slice(0, 40) : [];
    $('#res').innerHTML = t ? (r.length ? r.map(s => itemSitio({ s, p: plan(s) }, miPos && tieneGeo(s) ? distKm(miPos, { lat: Number(s.lat), lng: Number(s.lng) }) : null)).join('') : '<p class="empty">Sin resultados</p>') : '';
  };
}
function resumenGrupo(nombre, g, filtro) {
  const nT = g.filter(x => toca(x.p)).length, nAp = g.filter(x => x.s.prioridad === 'A+').length, nJ = g.filter(x => pendJ(x.s.id).length).length;
  return `<span class="zn">${esc(nombre)}</span><span class="zc">${nAp ? '<span class="prio pAp">A+</span>' : ''}${nJ ? '<span class="jbadge">J</span>' : ''}<b>${g.length}</b>${filtro === 'todos' && nT ? ` · ${nT} tocan` : ''}</span>`;
}
function paquetesInfo() {
  const asig = new Map((data?.paquetes || []).map(p => [String(p.id), p.asignado_a || '']));
  const m = new Map();
  (data?.sitios || []).forEach(x => {
    const id = String(x.paquete || 'Sin paquete');
    if (!m.has(id)) m.set(id, { id, zona: x.zona, asignado_a: asig.get(id) || '', sitios: [] });
    m.get(id).sitios.push(x);
  });
  return [...m.values()];
}
function esMio(p) { const a = norm(p.asignado_a); return !!a && (a === norm(auth.nombre) || a === String(auth.usuario)); }
function matchSitio(s, t) { return norm(`${s.nombre} ${s.direccion} ${s.id} ${s.abonado} ${s.zona} ${s.barrio || ''}`).includes(t); }

function itemSitio({ s, p }, dist, sinZona) {
  const u = p.u;
  return `<a class="card sitio ${prioClase(s)} ${s.situacion === 'cliente' ? 'cli' : 'nuevo'}${p.fuera ? ' bloq' : ''}" href="#/sitio/${s.id}">
    <div class="row"><strong>${prioTag(s)}${esc(s.nombre)}</strong><span class="der">${jTag(s.id)}${dist != null ? `<span class="dist">${fmtDist(dist)}</span>` : u ? `<span class="ok">✓ ${fmtFecha(u.fecha)}</span>` : ''}</span></div>
    <div class="muted small">${esc(TIPOS[s.tipo] || s.tipo)} · ${esc(s.direccion)}${!sinZona && (s.barrio || s.zona) ? ` · <em>${esc(s.barrio || s.zona)}</em>` : ''}</div>
    ${s.sin_recepcion ? '<div class="tag warn">Sin recepción</div> ' : ''}<div class="tag ${toca(p) && !p.pendiente ? 'warn' : ''}">${esc(textoPlan(p))}</div>
  </a>`;
}

/* ───────── 4 · FICHA DEL SITIO ───────── */
function vSitio(id) {
  if (esNuevoId(id)) return vSitioNuevo(id);
  const s = sitio(id);
  if (!s) { location.hash = '#/'; return; }
  header(s.nombre, volverA || '#/');
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
    ${pendJ(s.id).map(v => `<div class="alert azul"><span class="jbadge">J</span> Jorge debe contactar${v.contactar_motivo ? ': ' + esc(v.contactar_motivo) : ''} <span class="small">(${fmtFecha(v.fecha)})</span></div>`).join('')}
    <div class="plan ${pl.fuera ? 'fuera' : toca(pl) ? 'toca' : ''}">
      <b>${esc(textoPlan(pl))}</b>${!pl.fuera && !pl.pendiente ? `<span class="muted small"> · ${esc(pl.motivo)}</span>` : ''}
      ${pl.u ? `<div class="small muted">Última visita: ${fmtFecha(pl.u.fecha)} · ${esc(nombreUsuario(pl.u.usuario))}${sugerencia(pl.u) ? ` · sugiere: «${esc(sugerencia(pl.u))}»` : ''}</div>` : ''}
      ${auth.admin && !s.no_visitar ? `<div class="fijar"><input type="date" id="fjFecha" value="${esc(fijada(s.id))}"><button class="small-btn" id="fjBtn">Fijar próxima visita</button></div>` : ''}
    </div>
    <dl>
      ${s.prioridad || s.estado || auth.admin ? `<dt>Prioridad · Estado</dt><dd>${prioTag(s)}${esc(ESTADOS[norm(s.estado)] || s.estado || '—')}${s.prioridad_app ? ' <span class="muted small">· prioridad puesta en la app</span>' : ''}</dd>` : ''}
      ${auth.admin ? `<dd class="prio-sel" id="prioSel">${['A+', 'A', 'B', 'C'].map(k => `<button type="button" data-p="${k}" class="prio ${prioCls(k)} ${s.prioridad === k ? 'on' : ''}">${k}</button>`).join('')}
        ${s.prioridad_app ? `<button type="button" data-p="" class="small-btn">Volver a la del maestro (${esc(s.prioridad_maestro || 'sin')})</button>` : ''}</dd>` : ''}
      ${s.contacto ? `<dt>Contacto</dt><dd>${esc(s.contacto)}</dd>` : ''}
      ${s.barrio || s.zona ? `<dt>Zona · barrio</dt><dd>${esc([s.zona, s.barrio].filter(Boolean).join(' · '))}</dd>` : ''}
      <dt>Dirección</dt><dd data-copy="${esc(s.direccion)}">${esc(s.direccion) || '—'}</dd>
      <dt>Teléfono</dt><dd ${tel.txt ? `data-copy="${esc(tel.txt)}"` : ''}>${tel.txt ? (tel.ext ? `Ext. interna ${esc(tel.txt)}` : esc(tel.txt)) : '<span class="muted">sin dato</span>'}
        ${c.telNuevo ? `<span class="muted small"> · apuntado en visita ${fmtFecha(c.telNuevo.fecha)}</span>` : ''}</dd>
      <dt>Email</dt><dd ${c.email ? `data-copy="${esc(c.email)}"` : ''}>${c.email ? esc(c.email) : '<span class="muted">sin dato</span>'}
        ${c.emailNuevo ? `<span class="muted small"> · apuntado en visita ${fmtFecha(c.emailNuevo.fecha)}</span>` : ''}</dd>
      <dt>Foxtrot / botonera <span class="muted small">(estado actual)</span></dt><dd>${[
        s.tiene_foxtrot ? '<span class="chip fx">✓ Foxtrot</span> <span class="muted small">cuenta web en el PC de recepción</span>' : '',
        s.tiene_botonera ? '<span class="chip">✓ Botonera TB80</span> <span class="muted small">aparato físico (no se ofrece)</span>' : ''
      ].filter(Boolean).join('<br>') || '<span class="muted">Ninguno</span>'}</dd>
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
  const fb = $('#fjBtn');
  if (fb) fb.onclick = () => fijarProxima(s.id, $('#fjFecha').value);
  const ps = $('#prioSel');
  if (ps) ps.onclick = e => { const b = e.target.closest('button'); if (!b) return;
    online(async () => {
      const j = await call('fijarPrioridad', { sitio_id: s.id, prioridad: b.dataset.p });
      data.sitios = j.sitios; ls.set(LS.data, data);
      toast(b.dataset.p ? 'Prioridad ' + b.dataset.p : 'Prioridad del maestro'); rerender();
    }); };
}


function vSitioNuevo(id) {
  const s = pseudoSitio(id);
  if (!s) { location.hash = '#/'; return; }
  header(s.nombre, volverA || '#/');
  const vs = visitasDe(id);
  view.innerHTML = `
  <section class="card ficha">
    <div class="chips"><span class="chip nuevo">SITIO NUEVO · por revisar</span><span class="chip">${esc(TIPOS[s.tipo] || s.tipo)}</span></div>
    <dl>
      <dt>Dirección / zona</dt><dd data-copy="${esc(s.direccion)}">${esc(s.direccion) || '—'}</dd>
      <dt>Teléfono</dt><dd>${s.telefono ? esc(fmtTel(s.telefono).txt) : '<span class="muted">sin dato</span>'}</dd>
    </dl>
    <p class="small muted">Dado de alta en la calle. Jorge le asignará ficha definitiva.</p>
  </section>
  <h2 class="zona">Visitas (${vs.length})</h2>
  ${vs.map(v => tarjetaVisita(v)).join('')}`;
}

async function fijarProxima(sitioId, fecha) {
  return online(async () => {
    const j = await call('fijarProxima', { sitio_id: sitioId, fecha });
    data.proximas = j.proximas; ls.set(LS.data, data);
    toast(fecha ? 'Próxima visita: ' + fmtFecha(fecha) : 'Fecha quitada');
    rerender();
  });
}

function tarjetaVisita(v, conSitio) {
  const puedo = String(v.usuario) === String(auth.usuario) || auth.admin;
  const s = conSitio ? (sitio(v.sitio_id) || pseudoSitio(v.sitio_id) || { nombre: v.sitio_id }) : null;
  const items = [
    v.expositor_puesto ? 'expositor puesto' : 'sin expositor',
    v.planos_dejados ? 'planos dejados' : v.planos_tiene ? 'tenía planos' : 'sin planos',
    v.tarjetas_dejadas ? 'tarjetas dejadas' : v.tarjetas_tiene ? 'tenía tarjetas' : 'sin tarjetas',
    v.boligrafos_dados ? `${v.boligrafos_dados} bolis` : '',
    v.pegatina_puesta ? 'pegatina puesta' : '', v.cartel_puesto ? 'cartel puesto' : '', v.qr_puesto ? 'QR puesto' : ''
  ].filter(Boolean).join(' · ');
  const fotos = String(v.fotos || '').split(',').filter(Boolean);
  const fotosPend = fotosCola.filter(f => f.visita_id === v.id).length;
  return `<div class="card visita">
    <div class="row"><strong>${s ? `<a href="#/sitio/${esc(v.sitio_id)}">${prioTag(s)}${esc(s.nombre)}</a>` : fmtFecha(v.fecha) + ' ' + esc(v.hora)}</strong>
      <span class="muted small">${s ? fmtFecha(v.fecha) + ' · ' : ''}${esc(nombreUsuario(v.usuario))}${v._pend ? ' · <b class="pend">sin enviar</b>' : ''}</span></div>
    ${v.recibido_por ? `<div class="small">Recibe: ${esc(v.recibido_por)}</div>` : ''}
    <div class="small muted">${items}</div>
    ${v.jorge_contactar ? `<div class="tag ${v.contactado ? '' : 'warn'}">Jorge contacta${v.contactar_motivo ? ': ' + esc(v.contactar_motivo) : ''}${v.contactado ? ' ✓ hecho' : ''}</div>` : ''}
    ${v.foxtrot_ofrecer === true ? '<div class="tag fx">Ofrecer Foxtrot · hay recepción que pide taxi</div>' : ''}
    ${sugerencia(v) ? `<div class="small">Volver: <b>${esc(sugerencia(v))}</b></div>` : ''}
    ${fotos.length ? `<div class="thumbs">${fotos.map(id => `<a class="th" target="_blank" rel="noopener" href="https://drive.google.com/file/d/${esc(id)}/view"><img loading="lazy" alt="foto" src="${/^DEMO/.test(id) ? 'icon-192.png' : `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w300`}"></a>`).join('')}</div>` : ''}
    ${fotosPend ? `<div class="small">📷 <b class="pend">${fotosPend} foto${fotosPend > 1 ? 's' : ''} sin enviar</b></div>` : ''}
    ${v.observaciones ? `<p class="small">${esc(v.observaciones)}</p>` : ''}
    ${puedo ? `<a class="small link" href="#/visita/${v.sitio_id}/${encodeURIComponent(v.id)}">Editar</a>` : ''}
  </div>`;
}

/* ───────── 4b · VISITAS: mías / de cada uno / todas, por día, con buscador y Editar ───────── */
function vVisitas() {
  volverA = '#/visitas';
  header('Visitas', '#/');
  const quien = ls.get(LS.quien, String(auth.usuario));   // '' = todas
  const usuarios = data.usuarios || [];
  const base = visitas().filter(v => !quien || String(v.usuario) === quien)
    .sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora));
  view.innerHTML = `
  <div class="seg tabs" id="segQuien">
    <button data-v="${esc(auth.usuario)}" class="${quien === String(auth.usuario) ? 'on' : ''}">Mías</button>
    ${usuarios.filter(u => String(u.usuario) !== String(auth.usuario)).map(u => `<button data-v="${esc(u.usuario)}" class="${quien === String(u.usuario) ? 'on' : ''}">${esc(u.nombre)}</button>`).join('')}
    <button data-v="" class="${quien ? '' : 'on'}">Todas</button>
  </div>
  <div class="search"><input id="qv" type="search" placeholder="Buscar por sitio, quién os recibe, observaciones…" autocomplete="off"></div>
  <div id="listaV"></div>`;
  const pinta = t => {
    const arr = t ? base.filter(v => norm(`${nombreSitio(v.sitio_id)} ${v.sitio_id} ${v.recibido_por} ${v.observaciones} ${v.contactar_motivo} ${v.nuevo_nombre}`).includes(t)) : base;
    if (!arr.length) { $('#listaV').innerHTML = `<p class="empty">${t ? 'Sin resultados' : 'Aún no hay visitas'}</p>`; return; }
    const dias = [...new Set(arr.map(v => v.fecha))];
    $('#listaV').innerHTML = `<p class="muted small legend">${arr.length} visita${arr.length > 1 ? 's' : ''} · toca el nombre para ir a la ficha o «Editar» para corregir</p>` +
      dias.map(d => { const g = arr.filter(v => v.fecha === d);
        return `<h2 class="zona">${esc(fmtDiaLargo(d))} (${g.length})</h2>${g.map(v => tarjetaVisita(v, true)).join('')}`; }).join('');
  };
  pinta('');
  $('#qv').oninput = e => pinta(norm(e.target.value.trim()));
  $('#segQuien').onclick = e => { const b = e.target.closest('button'); if (!b) return; ls.set(LS.quien, b.dataset.v); vVisitas(); };
}
const fmtDiaLargo = iso => { const d = new Date(String(iso) + 'T12:00:00'); if (isNaN(d)) return fmtFecha(iso);
  const t = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return iso === hoyISO() ? 'Hoy · ' + t : iso === addDias(hoyISO(), -1) ? 'Ayer · ' + t : t; };

/* ───────── 5 · FORMULARIO DE VISITA ───────── */
function vForm(sitioId, visitaId) {
  const alta = sitioId === 'nuevo';
  const nuevo = alta || esNuevoId(sitioId);
  if (alta) sitioId = idNuevo();
  const s = nuevo ? (pseudoSitio(sitioId) || { id: sitioId, nombre: 'Sitio nuevo', telefono: '', email: '' }) : sitio(sitioId);
  if (!s) { location.hash = '#/'; return; }
  const prev = visitaId ? visitas().find(v => v.id === visitaId) : null;
  if (visitaId && !prev) { location.hash = '#/sitio/' + sitioId; return; }
  if (prev && String(prev.usuario) !== String(auth.usuario) && !auth.admin) { location.hash = '#/sitio/' + sitioId; return; }
  if (s.no_visitar && !auth.admin) { toast('No visitar en ronda: lo lleva Jorge'); location.hash = '#/sitio/' + sitioId; return; }
  header(prev ? 'Editar visita' : alta ? 'Sitio nuevo' : 'Nueva visita', alta ? (volverA || '#/') : volverA === '#/visitas' ? '#/visitas' : '#/sitio/' + sitioId);

  const v = prev ? { ...prev } : {
    id: uid(), sitio_id: s.id, usuario: auth.usuario, fecha: hoyISO(), hora: horaAhora(),
    recibido_por: '', expositor_puesto: null, planos_tiene: null, planos_dejados: false,
    tarjetas_tiene: null, tarjetas_dejadas: false, boligrafos_dados: 0, jorge_contactar: false,
    contactar_motivo: '', telefono_nuevo: '', email_nuevo: '', observaciones: '', volver: '',
    sitio_nuevo: nuevo, nuevo_nombre: '', nuevo_direccion: '', nuevo_tipo: '', nuevo_telefono: '',
    pegatina_puesta: false, cartel_puesto: false, qr_puesto: false, foxtrot_ofrecer: null, fotos: ''
  };
  const fotosNuevas = [];   // {foto_id, data, url} comprimidas en el móvil; se suben tras enviar la visita
  const yaFotos = String(v.fotos || '').split(',').filter(Boolean).length + fotosCola.filter(f => f.visita_id === v.id).length;
  const chip = (k, label) => `<button type="button" class="tg ${v[k] ? 'on' : ''}" data-tg="${k}">${label}</button>`;
  const c = contacto(s);
  const sinTel = !c.telefono || fmtTel(c.telefono).ext;
  const yn = (k, label, req) => `
    <div class="field"><span>${label}${req ? ' *' : ''}</span>
      <div class="seg yn" data-k="${k}">
        <button type="button" data-v="1" class="${v[k] === true ? 'on' : ''}">Sí</button>
        <button type="button" data-v="0" class="${v[k] === false ? 'on' : ''}">No</button>
      </div></div>`;

  const bloqueNuevo = nuevo ? `
    <fieldset class="alta"><legend>➕ Datos del sitio nuevo</legend>
      <label>Nombre * <input name="nuevo_nombre" value="${esc(v.nuevo_nombre)}" maxlength="120" autocomplete="off"></label>
      <label>Dirección / zona * <input name="nuevo_direccion" value="${esc(v.nuevo_direccion)}" maxlength="160" autocomplete="off"></label>
      <label>Tipo <select name="nuevo_tipo">${TIPOS_NUEVO.map(([k, t]) => `<option value="${k}" ${v.nuevo_tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Teléfono <span class="muted small">(opcional)</span> <input name="nuevo_telefono" type="tel" inputmode="tel" value="${esc(v.nuevo_telefono)}" autocomplete="off"></label>
    </fieldset>` : '';

  view.innerHTML = `
  <form id="fV" class="card form" novalidate>
    ${nuevo ? '' : `<p class="sitio-n">${esc(s.nombre)}</p>`}
    ${bloqueNuevo}
    <p class="muted small">${esc(nombreUsuario(v.usuario))} (usuario ${esc(v.usuario)})</p>
    <div class="two">
      <label>Fecha <input name="fecha" type="date" value="${esc(v.fecha)}" required></label>
      <label>Hora <input name="hora" type="time" value="${esc(v.hora)}" required></label>
    </div>
    <label>Quién os recibe <input name="recibido_por" value="${esc(v.recibido_por)}" placeholder="Nombre / cargo" autocomplete="off"></label>
    ${yn('expositor_puesto', '¿Tiene expositor puesto?', true)}
    <div class="field"><span>Colocado hoy <span class="muted small">(toca lo que hayas puesto)</span></span>
      <div class="toggles">${chip('pegatina_puesta', 'Pegatina')}${chip('cartel_puesto', 'Cartel')}${chip('qr_puesto', 'QR')}</div></div>
    ${s.tiene_foxtrot ? '<p class="muted small">Ya tiene Foxtrot (cuenta web en recepción).</p>'
      : s.sin_recepcion ? ''
      : `${yn('foxtrot_ofrecer', '¿Ofrecer Foxtrot?')}<p class="muted small hint">Solo si hay recepcionista y piden taxi a menudo (≈1-2 al día), y siempre con expositor y pegatinas. En comercios o sitios pequeños no merece la pena. La botonera no se ofrece nunca.</p>`}
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
    ${nuevo ? '' : `<label>Teléfono ${sinTel ? '<span class="tag warn">la ficha no lo tiene</span>' : '<span class="muted small">(solo si el de la ficha está mal)</span>'}
      <input name="telefono_nuevo" type="tel" inputmode="tel" value="${esc(v.telefono_nuevo)}" autocomplete="off"></label>`}
    <label>Email ${c.email ? '<span class="muted small">(solo si el de la ficha está mal)</span>' : '<span class="tag warn">la ficha no lo tiene</span>'}
      <input name="email_nuevo" type="email" inputmode="email" value="${esc(v.email_nuevo)}" autocomplete="off"></label>
    <label>Observaciones <textarea name="observaciones" rows="3">${esc(v.observaciones)}</textarea></label>
    <label>¿Cuándo volver? <span class="muted small">(sugerencia)</span>
      <input name="volver" value="${esc(sugerencia(v))}" maxlength="140" placeholder="Ej.: en dos semanas, por la mañana, cuando esté la jefa…" autocomplete="off"></label>
    <div class="field"><span>Fotos <span class="muted small">(opcional: pegatina, expositor, cartel…)${yaFotos ? ` · ya tiene ${yaFotos}` : ''}</span></span>
      <label class="foto-add">📷 Añadir fotos<input type="file" id="fotoIn" accept="image/*" multiple hidden></label>
      <div class="thumbs" id="thumbs"></div></div>
    <button class="primary big" type="submit">Guardar visita</button>
    ${prev ? '<button type="button" class="danger" id="btnDel">Borrar visita</button>' : ''}
  </form>`;

  const f = $('#fV');
  f.addEventListener('input', e => e.target.classList.remove('err'));
  f.querySelectorAll('.yn').forEach(g => g.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (g.dataset.k === 'foxtrot_ofrecer' && b.classList.contains('on')) { v.foxtrot_ofrecer = null; b.classList.remove('on'); return; }   // opcional: se puede desmarcar
    v[g.dataset.k] = b.dataset.v === '1';
    [...g.children].forEach(x => x.classList.toggle('on', x === b));
    g.closest('.field').classList.remove('err');
    if (g.dataset.k === 'jorge_contactar') $('#motivoBox').hidden = !v.jorge_contactar;
  });
  f.querySelectorAll('[data-tg]').forEach(b => b.onclick = () => { v[b.dataset.tg] = !v[b.dataset.tg]; b.classList.toggle('on', v[b.dataset.tg]); });
  const pintaFotos = () => { $('#thumbs').innerHTML = fotosNuevas.map((x, i) => `<span class="th"><img src="${x.url}" alt=""><button type="button" data-qf="${i}" aria-label="Quitar">✕</button></span>`).join(''); };
  $('#thumbs').onclick = e => { const b = e.target.closest('[data-qf]'); if (!b) return; fotosNuevas.splice(Number(b.dataset.qf), 1); pintaFotos(); };
  $('#fotoIn').onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    toast('Preparando foto' + (files.length > 1 ? 's' : '') + '…');
    for (const file of files) {
      try { const url = await comprimir(file); fotosNuevas.push({ foto_id: 'F-' + uid().slice(2, 14), data: url.split(',')[1], url }); }
      catch { toast('No se pudo leer una foto'); }
    }
    pintaFotos();
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
    ['fecha', 'hora', 'recibido_por', 'contactar_motivo', 'telefono_nuevo', 'email_nuevo', 'observaciones', 'volver',
      'nuevo_nombre', 'nuevo_direccion', 'nuevo_tipo', 'nuevo_telefono']
      .forEach(k => { if (f[k]) v[k] = f[k].value.trim(); });
    if (nuevo) {
      const falta = ['nuevo_nombre', 'nuevo_direccion'].filter(k => !v[k]);
      falta.forEach(k => f[k].classList.add('err'));
      if (falta.length) { f[falta[0]].focus(); return toast('Falta el nombre o la dirección del sitio nuevo'); }
    }
    v.boligrafos_dados = Math.max(0, parseInt(f.boligrafos_dados.value, 10) || 0);
    const faltan = ['expositor_puesto', 'planos_tiene', 'tarjetas_tiene'].filter(k => v[k] !== true && v[k] !== false);
    f.querySelectorAll('.yn').forEach(g => g.closest('.field').classList.toggle('err', faltan.includes(g.dataset.k)));
    if (!v.fecha || !v.hora) return toast('Falta fecha u hora');
    if (faltan.length) return toast('Marca Sí/No en los campos con *');
    if (v.email_nuevo && !/^\S+@\S+\.\S+$/.test(v.email_nuevo)) return toast('Email no válido');
    if (!v.jorge_contactar) v.contactar_motivo = '';
    guardar(v, (prev ? 'Visita corregida' : 'Visita guardada') + (fotosNuevas.length ? ` · ${fotosNuevas.length} foto${fotosNuevas.length > 1 ? 's' : ''}` : ''),
      fotosNuevas.map(x => ({ foto_id: x.foto_id, visita_id: v.id, data: x.data, creado: Date.now() })));
  };
}

async function guardar(v, msg, fotos = []) {
  const { _pend, ...limpia } = v;
  for (const ft of fotos) await fotosStore.put(ft);
  if (fotos.length) await cargarFotosCola();
  queue = queue.filter(x => x.id !== limpia.id).concat(limpia);
  ls.set(LS.queue, queue);
  toast(msg + (navigator.onLine || DEMO ? '' : ' · se enviará al tener red'));
  location.hash = volverA === '#/visitas' ? '#/visitas' : '#/sitio/' + v.sitio_id;
  sync({ silent: true });
}

/* ───────── 6 · PANEL (admin) ───────── */
function vPanel() {
  volverA = '#/panel';
  header('Panel', '#/');
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
  const nuevos = vs.filter(v => v.sitio_nuevo && !v.revisado).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const pend = vs.filter(v => v.jorge_contactar && !v.contactado).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const corr = vs.filter(v => v.telefono_nuevo || v.email_nuevo).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const ult = [...vs].sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora)).slice(0, 15);
  const sinExp = vs.filter(v => !v.exportado || v.exportado === 'MODIFICADA').length;
  const conGeo = (data.sitios || []).filter(tieneGeo).length;
  const geoNo = (data.sitios || []).filter(x => !tieneGeo(x) && x.geo === 'no').length;
  const sinGeoNo = (data.sitios || []).length - conGeo - geoNo;
  const porFijar = (data.sitios || []).map(s => ({ s, p: plan(s) })).filter(x => x.p.sinFijar)
    .sort((a, b) => b.p.u.fecha.localeCompare(a.p.u.fecha));

  view.innerHTML = `
  <section class="card">
    <div class="kpis"><div><b>${pc(k, total)}%</b><span>visitado</span></div><div><b>${(data.sitios || []).filter(x => toca(plan(x))).length}</b><span>tocan hoy</span></div><div><b>${vs.length}</b><span>visitas</span></div></div>
    <h3>Por zona</h3>
    ${zonas.map(z => `<div class="row small"><span>${esc(z.z)}</span><span>${z.k}/${z.n} · ${pc(z.k, z.n)}%</span></div><div class="bar thin"><i style="width:${pc(z.k, z.n)}%"></i></div>`).join('')}
    <h3>Por usuario</h3>
    ${users.map(u => `<div class="row small"><span>${esc(u.usuario)} · ${esc(u.nombre)}</span><span>${u.nv} visitas · ${u.ns} sitios${u.ult ? ' · últ. ' + fmtFecha(u.ult) : ''}</span></div>`).join('')}
  </section>

  <h2 class="zona">Sitios nuevos por revisar (${nuevos.length})</h2>
  ${nuevos.length ? nuevos.map(v => `<div class="card visita nuevo-rev">
      <div class="row"><strong>➕ ${esc(v.nuevo_nombre || v.sitio_id)}</strong><span class="muted small">${fmtFecha(v.fecha)} · ${esc(nombreUsuario(v.usuario))}</span></div>
      <div class="small">${esc(TIPOS[v.nuevo_tipo] || v.nuevo_tipo || '')} · ${esc(v.nuevo_direccion)}${v.nuevo_telefono ? ' · ' + esc(v.nuevo_telefono) : ''}</div>
      ${v.observaciones ? `<div class="small muted">${esc(v.observaciones)}</div>` : ''}
      <div class="fijar"><input type="text" placeholder="ID definitivo (S…) · opcional" data-defid="${esc(v.id)}" autocapitalize="characters">
        <button class="small-btn" data-rev="${esc(v.id)}">Revisado</button></div>
    </div>`).join('') + '<button class="secondary" id="btnNuevosCSV">Descargar CSV para Hoteles</button>' : '<p class="empty">Ninguno</p>'}

  <h2 class="zona">Jorge debe contactar (${pend.length})</h2>
  ${pend.length ? pend.map(v => { const s = sitio(v.sitio_id) || {}; const c = contacto(s.id ? s : { id: v.sitio_id });
    return `<div class="card visita">
      <div class="row"><a href="#/sitio/${v.sitio_id}"><strong>${esc(s.nombre || v.sitio_id)}</strong></a><span class="muted small">${fmtFecha(v.fecha)} · ${esc(nombreUsuario(v.usuario))}</span></div>
      <div class="small">${esc(v.contactar_motivo) || '<span class="muted">sin motivo</span>'}</div>
      <div class="small muted">${[fmtTel(c.telefono).txt, c.email, v.recibido_por && 'Recibe: ' + v.recibido_por].filter(Boolean).map(esc).join(' · ')}</div>
      <button class="small-btn" data-hecho="${esc(v.id)}">Marcar contactado</button>
    </div>`; }).join('') : '<p class="empty">Nada pendiente</p>'}

  <h2 class="zona">Fijar próxima visita (${porFijar.length})</h2>
  ${porFijar.length ? porFijar.map(({ s, p }) => `<div class="card visita">
      <div class="row"><a href="#/sitio/${s.id}"><strong>${prioTag(s)}${esc(s.nombre)}</strong></a><span class="muted small">${fmtFecha(p.u.fecha)} · ${esc(nombreUsuario(p.u.usuario))}</span></div>
      <div class="small">${sugerencia(p.u) ? 'Sugiere: <b>' + esc(sugerencia(p.u)) + '</b>' : '<span class="muted">sin sugerencia</span>'}</div>
      <div class="fijar"><input type="date" data-fjf="${s.id}" value="${p.fecha}"><button class="small-btn" data-fj="${s.id}">Fijar</button></div>
    </div>`).join('') : '<p class="empty">Todo fijado</p>'}

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
    ${paquetesInfo().map(p => `<div class="row small asig"><span>${esc(p.id)}</span>
      <select data-paq="${esc(p.id)}"><option value="">—</option>${(data.usuarios || []).map(u => `<option ${u.nombre === p.asignado_a ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select></div>`).join('')}
  </section>

  <h2 class="zona">Coordenadas (para «📍 Cerca»)</h2>
  <section class="card">
    <p class="small">${conGeo} de ${(data.sitios || []).length} sitios con coordenadas${sinGeoNo ? ` · ${sinGeoNo} sin calcular` : ''}${geoNo ? ` · ${geoNo} no encontrados (revisar dirección en el maestro)` : ''}.</p>
    ${sinGeoNo ? `<button class="primary" id="btnGeo">Calcular coordenadas (${sinGeoNo})</button>` : ''}
    ${geoNo ? `<button class="secondary" id="btnGeoRe">Reintentar no encontrados (${geoNo})</button>` : ''}
    <div id="geoOut" class="small"></div>
  </section>

  <h2 class="zona">Últimas visitas</h2>
  ${ult.map(v => tarjetaVisita(v, true)).join('') || '<p class="empty">Aún sin visitas</p>'}

  <h2 class="zona">Maestro de sitios</h2>
  <section class="card">
    <p class="small">Actual: ${(data.sitios || []).length} sitios (${total} en ronda). Cada carga reemplaza el maestro entero; las visitas se conservan (van por ID).</p>
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
  view.querySelectorAll('[data-rev]').forEach(b => b.onclick = () => online(async () => {
    const def = view.querySelector(`[data-defid="${b.dataset.rev}"]`).value.trim().toUpperCase();
    if (def && !/^S\d{3,}$/.test(def)) return toast('El ID definitivo debe ser tipo S215');
    if (def && !sitio(def)) return toast(def + ' no está en el maestro cargado');
    const j = await call('revisarNuevo', { id: b.dataset.rev, sitio_id: def });
    data.visitas = j.visitas; ls.set(LS.data, data); toast(def ? 'Visita enlazada a ' + def : 'Marcado como revisado'); vPanel();
  }));
  const bn = $('#btnNuevosCSV');
  if (bn) bn.onclick = () => descargarCSV(`SITIOS_NUEVOS_${hoyISO()}.csv`, ['id_provisional', 'nombre', 'direccion', 'tipo', 'telefono', 'observaciones', 'fecha', 'visitador', 'lat', 'lng'],
    nuevos.map(v => { const g = (data.geo_nuevos || []).find(x => x.sitio_id === v.sitio_id) || {};
      return { id_provisional: v.sitio_id, nombre: v.nuevo_nombre, direccion: v.nuevo_direccion, tipo: TIPOS[v.nuevo_tipo] || v.nuevo_tipo,
        telefono: v.nuevo_telefono, observaciones: v.observaciones, fecha: v.fecha, visitador: nombreUsuario(v.usuario), lat: g.lat ?? '', lng: g.lng ?? '' }; }));
  view.querySelectorAll('[data-fj]').forEach(b => b.onclick = () => {
    const f = view.querySelector(`[data-fjf="${b.dataset.fj}"]`).value;
    if (!f) return toast('Elige una fecha');
    fijarProxima(b.dataset.fj, f);
  });
  const geo = reintentar => online(async () => {
    const out = $('#geoOut'); let hechos = 0, fallidos = [], quedan = 1, vuelta = 0;
    view.querySelectorAll('#btnGeo, #btnGeoRe').forEach(b => { b.disabled = true; });
    while (quedan > 0 && vuelta < 30) {
      out.textContent = `Calculando… ${hechos} encontradas${fallidos.length ? ', ' + fallidos.length + ' sin resultado' : ''}. No cierres la app.`;
      const j = await call('geocodificar', { reintentar: reintentar && vuelta === 0 });
      hechos += j.hechos; fallidos = fallidos.concat(j.fallidos); quedan = j.quedan; vuelta++;
      if (!j.hechos && !j.fallidos.length) break;
      reintentar = false;
    }
    await refresh({ silent: true });
    toast(`Coordenadas: ${hechos} encontradas${fallidos.length ? ', ' + fallidos.length + ' sin resultado' : ''}`, 5000);
    if (fallidos.length) { const o = $('#geoOut'); if (o) o.innerHTML = '<b>Sin resultado (revisar dirección):</b><br>' + fallidos.map(esc).join('<br>'); }
  });
  view.querySelectorAll('[data-paq]').forEach(sel => sel.onchange = () => online(async () => {
    const j = await call('asignar', { paquete: sel.dataset.paq, asignado_a: sel.value });
    data.paquetes = j.paquetes; ls.set(LS.data, data); toast('Asignado');
  }));
  const bg = $('#btnGeo'); if (bg) bg.onclick = () => geo(false);
  const bgr = $('#btnGeoRe'); if (bgr) bgr.onclick = () => geo(true);
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
    case 'bootstrap': save(); return { ok: true, user, sitios: srv.sitios, paquetes: paqs(), visitas: vivas(), proximas: srv.prox || [],
      usuarios: srv.usuarios.map(x => ({ usuario: x.usuario, nombre: x.nombre })), ts: new Date().toISOString() };
    case 'sync': {
      const res = body.visitas.map(v => {
        const i = srv.visitas.findIndex(x => x.id === v.id);
        if (i >= 0) {
          if (srv.visitas[i].usuario !== user.usuario && !user.admin) return { id: v.id, ok: false, error: 'Solo puedes editar tus visitas' };
          srv.visitas[i] = { ...v, usuario: srv.visitas[i].usuario, contactado: srv.visitas[i].contactado, fotos: srv.visitas[i].fotos || '', exportado: srv.visitas[i].exportado ? 'MODIFICADA' : '' };
        } else if (!v.borrado) srv.visitas.push({ ...v, usuario: user.usuario, exportado: '', fotos: '' });
        return { id: v.id, ok: true };
      });
      save(); return { ok: true, resultados: res, visitas: vivas() };
    }
    case 'asignar': srv.asig[body.paquete] = body.asignado_a; save(); return { ok: true, paquetes: paqs() };
    case 'buscarCalle': return { ok: true, encontrado: true, lat: 38.3452, lng: -0.4815, direccion: body.texto + ' (demo)' };
    case 'fijarPrioridad': { const x = srv.sitios.find(y => y.id === body.sitio_id);
      if (x.prioridad_maestro === undefined) x.prioridad_maestro = x.prioridad || '';
      x.prioridad = body.prioridad || x.prioridad_maestro; x.prioridad_app = !!body.prioridad; save(); return { ok: true, sitios: srv.sitios }; }
    case 'geocodificar': { const pend = srv.sitios.filter(y => y.lat == null || y.lat === '').slice(0, 60);
      pend.forEach((y, i) => { if (i % 15 === 14) { y.geo = 'no'; return; } y.lat = 38.345 + (Math.random() - .5) * .06; y.lng = -0.485 + (Math.random() - .5) * .08; y.geo = 'ok'; });
      save(); return { ok: true, hechos: pend.filter(y => y.geo === 'ok').length, fallidos: pend.filter(y => y.geo === 'no').map(y => y.id + ' · ' + y.nombre),
        quedan: srv.sitios.filter(y => (y.lat == null || y.lat === '') && y.geo !== 'no').length }; }
    case 'subirFoto': { const v = srv.visitas.find(x => x.id === body.visita_id); if (!v) fail('Visita no encontrada');
      const id = 'DEMO' + body.foto_id; if (!String(v.fotos || '').includes(id)) v.fotos = [v.fotos, id].filter(Boolean).join(',');
      save(); return { ok: true, file_id: id }; }
    case 'revisarNuevo': { const v = srv.visitas.find(x => x.id === body.id); v.revisado = true; if (body.sitio_id) v.sitio_id = body.sitio_id; save(); return { ok: true, visitas: vivas() }; }
    case 'fijarProxima': srv.prox = (srv.prox || []).filter(x => x.sitio_id !== body.sitio_id).concat(body.fecha ? [{ sitio_id: body.sitio_id, fecha: body.fecha }] : []); save(); return { ok: true, proximas: srv.prox };
    case 'contactado': srv.visitas.find(v => v.id === body.id).contactado = body.valor; save(); return { ok: true, visitas: vivas() };
    case 'cargarSeed': srv.sitios = body.seed.sitios || body.seed; save(); return { ok: true, total: srv.sitios.length };
    case 'exportar': {
      const filas = vivas().filter(v => body.todas || !v.exportado || v.exportado === 'MODIFICADA').map(v => {
        const s = srv.sitios.find(x => x.id === v.sitio_id) || {};
        const f = v.fecha.split('-');
        const act = ['Expositor ' + (v.expositor_puesto ? 'puesto' : 'NO puesto'), v.planos_dejados ? 'planos dejados' : !v.planos_tiene ? 'sin planos' : '',
          v.tarjetas_dejadas ? 'tarjetas dejadas' : !v.tarjetas_tiene ? 'sin tarjetas' : '', v.boligrafos_dados ? v.boligrafos_dados + ' bolis' : ''].filter(Boolean).join(', ');
        const row = { 'FECHA VISITA': `${f[2]}/${f[1]}/${f[0]}`, 'VISITADOR': srv.usuarios.find(x => x.usuario === v.usuario)?.nombre, 'CLIENTE': s.nombre || (v.nuevo_nombre ? v.nuevo_nombre + ' (NUEVO)' : v.sitio_id),
          'TELÉFONO': v.telefono_nuevo || s.telefono || '', 'TIPO CONTACTO': 'VISITA PRESENCIAL', 'ACTUACIÓN REALIZADA': act,
          'PRÓXIMO PASO': [v.jorge_contactar ? 'Jorge contacta: ' + (v.contactar_motivo || '') : '', sugerencia(v) ? 'Volver: ' + sugerencia(v) : ''].filter(Boolean).join(' · '),
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
/* Actualización automática: el código nuevo llega solo (service worker) y los datos se refrescan al abrir y al volver a la app */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;               // primera instalación: nada que avisar
    if (/^#\/visita/.test(location.hash)) {  // no cortar un formulario a medias
      const b = $('#banner'); b.hidden = false; b.textContent = 'Nueva versión disponible · se aplicará al guardar';
      window.addEventListener('hashchange', () => location.reload(), { once: true });
    } else { toast('Nueva versión de la app'); setTimeout(() => location.reload(), 800); }
  });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && auth && Date.now() - lastRefresh > 2 * 60000) sync({ silent: true }).then(() => refresh({ silent: true }));
});
const ver = document.createElement('div'); ver.id = 'ver'; ver.textContent = 'v' + APP_V; document.body.appendChild(ver);
const mPaq = $('#menu [data-go="#/paquetes"]'); if (mPaq) { mPaq.textContent = 'Lista de sitios'; mPaq.dataset.go = '#/';
  const mv = document.createElement('button'); mv.dataset.go = '#/visitas'; mv.textContent = 'Visitas'; mPaq.after(mv); }
route();
cargarFotosCola().then(() => { if (auth && data) sync({ silent: true }).then(() => refresh({ silent: true })); });
})();
