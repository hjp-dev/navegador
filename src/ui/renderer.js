const $ = (id) => document.getElementById(id);

const state = { tabs: [], activeId: null, bookmarks: [], downloads: [], passwords: { entries: [], presets: [] }, devices: [], scanning: false, scanned: false, fetchingStatus: false, panel: null };

const address = $('address');
let editingAddress = false;

// ---------- Helpers ----------
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

function icon(src) {
  if (!src) return el('span', { className: 'dot' });
  const img = el('img', { src });
  img.onerror = () => img.replaceWith(el('span', { className: 'dot' }));
  return img;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

const activeTab = () => state.tabs.find(t => t.id === state.activeId);

// ---------- Pestañas ----------
function renderTabs() {
  const container = $('tabs');
  container.replaceChildren(...state.tabs.map(tab => {
    const close = el('button', { className: 'icon close', title: 'Cerrar pestaña', textContent: '✕' });
    close.onclick = (e) => { e.stopPropagation(); browser.closeTab(tab.id); };

    const node = el('div', { className: 'tab' + (tab.id === state.activeId ? ' active' : ''), title: tab.title },
      tab.loading ? el('span', { className: 'spinner' }) : icon(tab.favicon),
      el('span', { className: 'title', textContent: tab.title }),
      close,
    );
    node.onclick = () => browser.activateTab(tab.id);
    node.onauxclick = (e) => { if (e.button === 1) browser.closeTab(tab.id); }; // clic central
    return node;
  }));
}

function renderNavbar() {
  const tab = activeTab();
  $('back').disabled = !tab?.canGoBack;
  $('forward').disabled = !tab?.canGoForward;
  $('reload').textContent = tab?.loading ? '✕' : '↻';
  $('reload').title = tab?.loading ? 'Detener' : 'Recargar (Ctrl+R)';

  if (!editingAddress) address.value = tab?.url || '';

  const starred = !!tab && state.bookmarks.some(b => b.url === tab.url);
  $('star').textContent = starred ? '★' : '☆';
  $('star').classList.toggle('on', starred);
  $('star').title = starred ? 'Quitar de favoritos (Ctrl+D)' : 'Añadir a favoritos (Ctrl+D)';

  document.title = tab ? `${tab.title} - Navegador` : 'Navegador';

  $('pw-badge').hidden = !tab?.savedLogins;

  // Aviso "¿Guardar contraseña?" de la pestaña activa
  const prompt = tab?.pwPrompt;
  $('infobar').hidden = !prompt;
  if (prompt) {
    const who = prompt.username ? `de «${prompt.username}» ` : '';
    $('infobar-text').textContent = prompt.update
      ? `¿Actualizar la contraseña ${who}para ${prompt.origin}?`
      : `¿Guardar la contraseña ${who}para ${prompt.origin}?`;
    $('pw-save').textContent = prompt.update ? 'Actualizar' : 'Guardar';
  }
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

// ---------- Panel lateral ----------
function openPanel(name) {
  state.panel = state.panel === name ? null : name;
  browser.setPanel(!!state.panel);
  if (state.panel === 'downloads') $('dl-badge').hidden = true;
  renderPanel();
}

function renderPanel() {
  const panel = $('panel');
  panel.hidden = !state.panel;
  if (!state.panel) return;

  const list = $('panel-list');
  const empty = $('panel-empty');

  if (state.panel === 'bookmarks') {
    $('panel-title').textContent = 'Favoritos';
    $('panel-clear').hidden = true;
    empty.textContent = 'Aún no tienes favoritos. Pulsa ☆ en la barra de direcciones para añadir uno.';
    list.replaceChildren(...state.bookmarks.map(b => {
      const remove = el('button', { className: 'icon', title: 'Eliminar', textContent: '✕' });
      remove.onclick = (e) => { e.stopPropagation(); browser.removeBookmark(b.url); };
      const item = el('li', { className: 'item link', title: b.url },
        icon(b.favicon),
        el('div', { className: 'info' },
          el('div', { className: 'name', textContent: b.title || b.url }),
          el('div', { className: 'sub', textContent: b.url }),
        ),
        remove,
      );
      item.onclick = () => browser.openBookmark(b.url);
      item.onauxclick = (e) => { if (e.button === 1) browser.newTab(b.url); };
      return item;
    }));
    empty.hidden = state.bookmarks.length > 0;
  } else if (state.panel === 'passwords') {
    // No redibujar mientras se escribe en el formulario de predefinidas
    if (document.activeElement?.closest?.('.preset-form') && $('panel-list').contains(document.activeElement)) return;
    $('panel-title').textContent = 'Contraseñas';
    $('panel-clear').hidden = true;
    const { entries, presets } = state.passwords;
    const here = originOf(activeTab()?.url);
    const mine = entries.filter(p => p.origin === here);
    const others = entries.filter(p => p.origin !== here);
    list.replaceChildren(...[
      mine.length ? el('li', { className: 'section', textContent: 'Este sitio' }) : null,
      ...mine.map(p => renderPassword(p, true)),
      el('li', { className: 'section', textContent: 'Predefinidas (equipos de la red interna)' }),
      ...presets.map(renderPreset),
      renderPresetForm(),
      others.length ? el('li', { className: 'section', textContent: 'Otros sitios' }) : null,
      ...others.map(p => renderPassword(p, false)),
    ].filter(Boolean));
    empty.hidden = true;
  } else {
    $('panel-title').textContent = 'Descargas';
    $('panel-clear').hidden = !state.downloads.some(d => !['progressing', 'paused'].includes(d.state));
    empty.textContent = 'No hay descargas.';
    list.replaceChildren(...state.downloads.map(renderDownload));
    empty.hidden = state.downloads.length > 0;
  }
}

function renderPassword(p, current) {
  const action = (label, fn) => {
    const btn = el('button', { className: 'text', textContent: label });
    btn.onclick = fn;
    return btn;
  };
  return el('li', { className: 'item', title: p.origin },
    el('div', { className: 'info' },
      el('div', { className: 'name', textContent: p.username || '(sin usuario)' }),
      el('div', { className: 'sub', textContent: p.origin }),
      el('div', { className: 'actions' },
        current ? action('Rellenar', () => browser.fillPassword(p.id)) : action('Abrir', () => browser.navigate(p.origin)),
        action('Copiar contraseña', () => browser.copyPassword(p.id)),
        action('Eliminar', () => { if (confirm(`¿Eliminar la contraseña de ${p.username || p.origin}?`)) browser.removePassword(p.id); }),
      ),
    ),
  );
}

function renderPreset(p) {
  const action = (label, fn) => {
    const btn = el('button', { className: 'text', textContent: label });
    btn.onclick = fn;
    return btn;
  };
  return el('li', { className: 'item', title: p.hosts || 'Toda la red interna' },
    el('div', { className: 'info' },
      el('div', { className: 'name', textContent: `${p.label || 'Predefinida'} — ${p.username || '(sin usuario)'}` }),
      el('div', { className: 'sub', textContent: p.hosts ? `Para: ${p.hosts}` : 'Para: toda la red interna' }),
      el('div', { className: 'actions' },
        action('Rellenar', () => browser.fillPassword(p.id)),
        action('Copiar contraseña', () => browser.copyPassword(p.id)),
        action('Eliminar', () => { if (confirm(`¿Eliminar la credencial predefinida «${p.label || p.username}»?`)) browser.removePassword(p.id); }),
      ),
    ),
  );
}

// Formulario para añadir una credencial predefinida (p. ej. la de la empresa para todas las antenas)
function renderPresetForm() {
  const input = (placeholder, type = 'text') => el('input', { type, placeholder, spellcheck: false, autocomplete: 'off' });
  const label = input('Nombre (p. ej. Antenas empresa)');
  const user = input('Usuario');
  const pass = input('Contraseña', 'password');
  const hosts = input('IPs (vacío = toda la red interna; admite 10.0.*)');
  const add = el('button', { className: 'primary', type: 'submit', textContent: 'Añadir predefinida' });
  const form = el('form', { className: 'preset-form' }, label, user, pass, hosts, add);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!pass.value) { pass.focus(); return; }
    document.activeElement?.blur();
    browser.addPreset({ label: label.value, username: user.value, password: pass.value, hosts: hosts.value });
  };
  return el('li', { className: 'item' }, form);
}

// ---------- Vista completa de antenas (tabla con filtro de columnas) ----------
const deviceKey = (d) => d.mac || d.ip;
const mgmtIp = (d) => ((d.ips && d.ips.length) ? d.ips[0] : d.ip);
const wanIps = (d) => ((d.ips && d.ips.length) ? d.ips.slice(1) : []).join(', ');

// Definición de columnas. `get` devuelve el texto de la celda.
const DEVICE_COLUMNS = [
  { key: 'name',     label: 'Nombre',   get: (d) => d.name || '' },
  { key: 'model',    label: 'Modelo',   get: (d) => d.model || '' },
  { key: 'lan',      label: 'IP (gestión/LAN)', get: (d) => mgmtIp(d) },
  { key: 'wan',      label: 'WAN / otras IPs',  get: (d) => wanIps(d) },
  { key: 'mac',      label: 'MAC',      get: (d) => d.mac || '' },
  { key: 'essid',    label: 'SSID',     get: (d) => d.essid || (d.status && d.status.essid) || '' },
  { key: 'mode',     label: 'Modo',     get: (d) => (d.status && d.status.mode) || '' },
  { key: 'signal',   label: 'Señal',    get: (d) => d.status && d.status.signal != null ? `${d.status.signal} dBm` : '' },
  { key: 'ccq',      label: 'CCQ',      get: (d) => d.status && d.status.ccq != null ? `${d.status.ccq} %` : '' },
  { key: 'firmware', label: 'Firmware', get: (d) => (d.status && d.status.fwversion) || d.firmware || '' },
  { key: 'estado',   label: 'Estado consulta', get: (d) => !d.status ? '' : (d.status.ok ? `OK (${d.status.scheme})` : `Error: ${d.status.error}`) },
];

function loadColVis() {
  try { return { ...Object.fromEntries(DEVICE_COLUMNS.map(c => [c.key, true])), ...JSON.parse(localStorage.getItem('dv-cols') || '{}') }; }
  catch { return Object.fromEntries(DEVICE_COLUMNS.map(c => [c.key, true])); }
}
let colVis = loadColVis();
function saveColVis() { try { localStorage.setItem('dv-cols', JSON.stringify(colVis)); } catch {} }

function openDevicesView() {
  $('devices-view').hidden = false;
  browser.setModal(true); // oculta la página para mostrar la tabla a pantalla completa
  renderDevicesView();
  if (!state.scanning && !state.scanned) browser.scanDevices();
}
function closeDevicesView() {
  $('devices-view').hidden = true;
  browser.setModal(false);
}

function renderColToggles() {
  const box = $('dv-cols-list');
  box.replaceChildren(...DEVICE_COLUMNS.map(c => {
    const cb = el('input', { type: 'checkbox', checked: colVis[c.key] !== false });
    cb.onchange = () => { colVis[c.key] = cb.checked; saveColVis(); renderDevicesTable(); };
    return el('label', {}, cb, document.createTextNode(' ' + c.label));
  }));
}

function renderDevicesTable() {
  const cols = DEVICE_COLUMNS.filter(c => colVis[c.key] !== false);
  const head = $('dv-head');
  head.replaceChildren(...cols.map(c => el('th', { textContent: c.label })), el('th', { textContent: 'Acciones' }));

  const rows = $('dv-rows');
  rows.replaceChildren(...state.devices.map(d => {
    const tr = el('tr', {}, ...cols.map(c => el('td', { textContent: c.get(d) || '—' })));
    const open = (label, url) => { const b = el('button', { className: 'text', textContent: label }); b.onclick = () => browser.navigate(url); return b; };
    const copy = el('button', { className: 'text', textContent: 'Copiar IP' });
    copy.onclick = () => navigator.clipboard?.writeText(mgmtIp(d));
    tr.append(el('td', { className: 'dv-actions' }, open('Abrir', mgmtIp(d)), open('https', 'https://' + mgmtIp(d)), copy));
    return tr;
  }));

  const empty = $('dv-empty');
  if (state.scanning) { empty.textContent = 'Buscando equipos en la red…'; empty.hidden = false; }
  else if (!state.devices.length) { empty.textContent = state.scanned ? 'No se encontraron equipos Ubiquiti en la red local.' : 'Pulsa «Buscar equipos».'; empty.hidden = false; }
  else { empty.hidden = true; }

  $('dv-count').textContent = state.devices.length ? `${state.devices.length} equipo(s)` : '';
}

function renderDevicesView() {
  if ($('devices-view').hidden) return;
  $('dv-scan').disabled = state.scanning;
  $('dv-scan').textContent = state.scanning ? 'Buscando…' : 'Buscar equipos';
  $('dv-status').disabled = state.fetchingStatus || !state.devices.length;
  $('dv-status').textContent = state.fetchingStatus ? 'Consultando…' : 'Obtener señal/CCQ';
  renderColToggles();
  renderDevicesTable();
}

function renderDownload(d) {
  const action = (label, name) => {
    const btn = el('button', { className: 'text', textContent: label });
    btn.onclick = () => browser.downloadAction({ id: d.id, action: name });
    return btn;
  };

  let status, actions = [], progress = null;
  switch (d.state) {
    case 'progressing':
    case 'paused':
      status = `${formatBytes(d.received)}${d.total ? ' de ' + formatBytes(d.total) : ''}${d.state === 'paused' ? ' · En pausa' : ''}`;
      progress = el('progress', d.total ? { max: d.total, value: d.received } : {});
      actions = [
        d.state === 'paused' ? action('Reanudar', 'resume') : action('Pausar', 'pause'),
        action('Cancelar', 'cancel'),
      ];
      break;
    case 'completed':
      status = formatBytes(d.total || d.received);
      actions = [action('Abrir', 'open'), action('Mostrar en carpeta', 'show'), action('Quitar', 'remove')];
      break;
    case 'cancelled':
      status = 'Cancelada';
      actions = [action('Quitar', 'remove')];
      break;
    default:
      status = 'Error en la descarga';
      actions = [action('Quitar', 'remove')];
  }

  return el('li', { className: 'item', title: d.path || d.url },
    el('div', { className: 'info' },
      el('div', { className: 'name', textContent: d.filename }),
      el('div', { className: 'sub', textContent: status }),
      progress,
      el('div', { className: 'actions' }, ...actions),
    ),
  );
}

// ---------- Eventos de la interfaz ----------
$('back').onclick = () => browser.back();
$('forward').onclick = () => browser.forward();
$('reload').onclick = () => browser.reload();
$('new-tab').onclick = () => browser.newTab();
$('star').onclick = () => browser.toggleBookmark();
$('bookmarks-btn').onclick = () => openPanel('bookmarks');
$('downloads-btn').onclick = () => openPanel('downloads');
$('passwords-btn').onclick = () => openPanel('passwords');
$('devices-btn').onclick = () => openDevicesView();
$('dv-close').onclick = () => closeDevicesView();
$('dv-scan').onclick = () => browser.scanDevices();
$('dv-status').onclick = () => browser.fetchDeviceStatus();
$('pw-save').onclick = () => browser.passwordPrompt({ tabId: state.activeId, action: 'save' });
$('pw-never').onclick = () => browser.passwordPrompt({ tabId: state.activeId, action: 'never' });
$('pw-dismiss').onclick = () => browser.passwordPrompt({ tabId: state.activeId, action: 'dismiss' });
$('panel-close').onclick = () => openPanel(state.panel);
$('panel-clear').onclick = () => browser.clearDownloads();

$('tabbar').ondblclick = (e) => { if (e.target.id === 'tabbar' || e.target.id === 'tabs') browser.newTab(); };

$('address-form').onsubmit = (e) => {
  e.preventDefault();
  editingAddress = false;
  browser.navigate(address.value);
  address.blur();
};
address.onfocus = () => { editingAddress = true; address.select(); };
address.onblur = () => { editingAddress = false; renderNavbar(); };
address.onkeydown = (e) => {
  if (e.key === 'Escape') { editingAddress = false; renderNavbar(); address.select(); }
};

function focusAddress() {
  address.focus();
  address.select();
}

// ---------- Mensajes del proceso principal ----------
browser.on('tabs', ({ tabs, activeId, bookmarks }) => {
  const switched = activeId !== state.activeId;
  Object.assign(state, { tabs, activeId, bookmarks });
  if (switched && document.activeElement !== address) editingAddress = false;
  renderTabs();
  renderNavbar();
  if (state.panel === 'bookmarks' || state.panel === 'passwords') renderPanel();
});

browser.on('passwords', (passwords) => {
  state.passwords = passwords;
  if (state.panel === 'passwords') renderPanel();
});

browser.on('scan-state', ({ scanning }) => {
  state.scanning = scanning;
  if (scanning) state.scanned = true;
  renderDevicesView();
});

browser.on('devices', (devices) => {
  state.devices = devices;
  renderDevicesView();
});

browser.on('status-state', ({ fetching }) => {
  state.fetchingStatus = fetching;
  renderDevicesView();
});

// Resultado de señal/CCQ de un equipo: se mezcla en su fila
browser.on('device-status', ({ key, status }) => {
  const d = state.devices.find(x => (x.mac || x.ip) === key);
  if (d) { d.status = status; renderDevicesTable(); }
});

// ---------- Inicio de sesión HTTP (ventanita de usuario/contraseña del router) ----------
const authQueue = [];

function showNextAuth() {
  const request = authQueue[0];
  $('modal').hidden = !request;
  browser.setModal(!!request);
  if (!request) return;
  $('auth-origin').textContent = request.isProxy
    ? `El proxy ${request.origin} requiere usuario y contraseña`
    : `${request.origin}${request.realm ? ` — «${request.realm}»` : ''}`;
  $('auth-error').hidden = !request.failed;
  $('auth-user').value = request.username;
  $('auth-pass').value = '';
  $('auth-remember').checked = true;
  $('auth-remember').parentElement.hidden = request.isProxy;
  (request.username ? $('auth-pass') : $('auth-user')).focus();
}

function answerAuth(response) {
  const request = authQueue.shift();
  if (request) browser.authResponse({ id: request.id, ...response });
  showNextAuth();
}

$('auth-form').onsubmit = (e) => {
  e.preventDefault();
  answerAuth({ username: $('auth-user').value, password: $('auth-pass').value, remember: $('auth-remember').checked });
};
$('auth-cancel').onclick = () => answerAuth({});
$('auth-form').onkeydown = (e) => { if (e.key === 'Escape') answerAuth({}); };

browser.on('auth-request', (request) => {
  authQueue.push(request);
  if (authQueue.length === 1) showNextAuth();
});

// El alto de la parte superior cambia al mostrar el aviso de contraseña
new ResizeObserver(() => {
  const h = $('chrome').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--chrome-h', `${h}px`);
  browser.setChromeHeight(h);
}).observe($('chrome'));

browser.on('downloads', (downloads) => {
  state.downloads = downloads;
  if (state.panel === 'downloads') renderPanel();
  else if (downloads.some(d => d.state === 'progressing')) $('dl-badge').hidden = false;
});

browser.on('show-panel', (name) => {
  if (name === 'devices') { openDevicesView(); return; }
  if (state.panel !== name) openPanel(name);
});

browser.on('focus-address', focusAddress);
