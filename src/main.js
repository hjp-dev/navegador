const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, session, clipboard } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const passwords = require('./passwords');
const discovery = require('./ubnt-discovery');
const status = require('./ubnt-status');
const vpn = require('./vpn');

// Página de inicio propia del navegador (no Google)
const HOME_URL = pathToFileURL(path.join(__dirname, 'ui', 'home.html')).href;
const SEARCH_URL = 'https://www.google.com/search?q=';
const isHomeUrl = (url) => !!url && (url === HOME_URL || url.startsWith(HOME_URL.split('#')[0]));
const PANEL_WIDTH = 320;   // panel lateral de favoritos/descargas/contraseñas

let win;
let tabs = [];          // { id, view }
let activeId = null;
let nextTabId = 1;
let panelOpen = false;
let modalOpen = false;  // diálogo de usuario/contraseña del sitio (oculta la página)
let chromeHeight = 76;  // alto de la interfaz superior (pestañas + navegación + avisos)

// ---------- Favoritos (persistidos en JSON) ----------
const bookmarksFile = () => path.join(app.getPath('userData'), 'favoritos.json');

function loadBookmarks() {
  try {
    return JSON.parse(fs.readFileSync(bookmarksFile(), 'utf8'));
  } catch {
    return [];
  }
}

function saveBookmarks(list) {
  fs.writeFileSync(bookmarksFile(), JSON.stringify(list, null, 2));
}

let bookmarks = [];

// ---------- Descargas ----------
let downloads = [];     // { id, filename, path, url, received, total, state }
let nextDownloadId = 1;
const downloadItems = new Map(); // id -> DownloadItem (mientras sigue activa)

function sendDownloads() {
  send('downloads', downloads);
}

// ---------- Utilidades ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Direcciones de red interna: IPs privadas, CGNAT (100.64/10), localhost y nombres locales
function isPrivateHost(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (/\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host)) return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function normalizeInput(input) {
  const text = input.trim();
  if (!text) return HOME_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|view-source):/i.test(text)) return text; // ya tiene esquema
  // Routers, ONUs y demás equipos de la red interna: http directo
  const host = text.match(/^([^/:?#\s]+)(:\d+)?([/?#]|$)/)?.[1];
  if (host && (isPrivateHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host))) return 'http://' + text;
  if (!/\s/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text)) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function focusAddress() {
  win.webContents.focus();
  send('focus-address');
}

function getTab(id) {
  return tabs.find(t => t.id === id);
}

function activeTab() {
  return getTab(activeId);
}

function tabInfo(tab) {
  const wc = tab.view.webContents;
  const url = wc.getURL();
  return {
    id: tab.id,
    title: wc.getTitle() || 'Nueva pestaña',
    url: isHomeUrl(url) ? '' : url, // en la página de inicio, barra de direcciones vacía
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    favicon: tab.favicon || null,
    savedLogins: originOf(wc.getURL()) ? credentialsFor(originOf(wc.getURL())).length : 0,
    pwPrompt: tab.pwPrompt ? { origin: tab.pwPrompt.origin, username: tab.pwPrompt.username, update: tab.pwPrompt.update } : null,
  };
}

function sendTabs() {
  send('tabs', { tabs: tabs.map(tabInfo), activeId, bookmarks });
}

function originOf(url) {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function layout() {
  const tab = activeTab();
  if (!win || !tab) return;
  const [width, height] = win.getContentSize();
  const w = panelOpen ? Math.max(0, width - PANEL_WIDTH) : width;
  tab.view.setBounds({ x: 0, y: chromeHeight, width: w, height: Math.max(0, height - chromeHeight) });
  tab.view.setVisible(!modalOpen);
}

// ---------- Pestañas ----------
function createTab(url = HOME_URL, activate = true, opts = {}) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'page-preload.js'),
      nodeIntegrationInSubFrames: true, // el preload también corre en iframes (muchos routers los usan)
      contextIsolation: true,
      sandbox: true,
    },
  });
  const tab = { id: nextTabId++, view, favicon: null, pwPrompt: null, autologin: !!opts.autologin };
  tabs.push(tab);

  const wc = view.webContents;
  const update = () => sendTabs();
  // Autologin: al terminar de cargar, pide a la página que rellene y envíe el login
  if (opts.autologin) {
    let tries = 0;
    const kick = () => {
      if (tries++ > 4) return; // reintenta algunas veces (airOS 8 dibuja el login con JS)
      for (const frame of wc.mainFrame.framesInSubtree) frame.send('pw:autosubmit');
    };
    wc.on('did-finish-load', kick);
    wc.on('did-frame-finish-load', kick);
  }
  wc.on('page-title-updated', update);
  wc.on('did-start-loading', update);
  wc.on('did-stop-loading', update);
  wc.on('did-navigate', (_e, _url, code) => {
    if (code !== 401) clearAuthAttempts(wc.id);
    update();
  });
  wc.on('did-navigate-in-page', update);
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0] || null;
    update();
  });

  // Enlaces que abren ventana nueva -> pestaña nueva
  wc.setWindowOpenHandler(({ url: target }) => {
    createTab(target, true);
    return { action: 'deny' };
  });

  // Botones de la página de inicio: enlaces a navegador.home/* que abren paneles del navegador
  wc.on('will-navigate', (e, target) => {
    try {
      const u = new URL(target);
      if (u.hostname === 'navegador.home') {
        e.preventDefault();
        handleHomeCommand(u.pathname.replace(/^\//, ''));
      }
    } catch {}
  });

  wc.loadURL(url);
  if (activate) activateTab(tab.id);
  else sendTabs();
  return tab;
}

function handleHomeCommand(cmd) {
  const panel = { antenas: 'devices', favoritos: 'bookmarks', descargas: 'downloads', contrasenas: 'passwords', vpn: 'vpn' }[cmd];
  if (panel) send('show-panel', panel);
}

// Vista "todas las pestañas": captura una miniatura de cada pestaña y la manda a la interfaz
async function openTabOverview() {
  const list = await Promise.all(tabs.map(async (t) => {
    const wc = t.view.webContents;
    let thumb = null;
    try {
      // La captura de pestañas en segundo plano puede tardar o no responder: se limita el tiempo
      const img = await Promise.race([
        wc.capturePage(),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      if (img && !img.isEmpty()) thumb = img.resize({ width: 360 }).toDataURL();
    } catch {}
    const url = wc.getURL();
    return {
      id: t.id,
      title: wc.getTitle() || (isHomeUrl(url) ? 'Inicio' : 'Nueva pestaña'),
      url: isHomeUrl(url) ? 'Inicio' : url,
      favicon: t.favicon || null,
      thumb,
    };
  }));
  send('tab-overview', { tabs: list, activeId });
}

function activateTab(id) {
  const tab = getTab(id);
  if (!tab) return;
  const prev = activeTab();
  if (prev && prev !== tab) win.contentView.removeChildView(prev.view);
  win.contentView.addChildView(tab.view);
  activeId = id;
  layout();
  tab.view.webContents.focus();
  sendTabs();
}

function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  if (activeId === id) win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();

  if (tabs.length === 0) {
    win.close();
    return;
  }
  if (activeId === id) {
    activateTab(tabs[Math.min(index, tabs.length - 1)].id);
  } else {
    sendTabs();
  }
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const index = tabs.findIndex(t => t.id === activeId);
  activateTab(tabs[(index + step + tabs.length) % tabs.length].id);
}

// ---------- Ventana ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 500,
    minHeight: 300,
    title: 'Navegador',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true, // el menú solo existe para los atajos de teclado
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.webContents.once('did-finish-load', () => {
    // Permite abrir una URL pasada por línea de comandos: npm start -- ejemplo.com
    const arg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('-'));
    createTab(arg ? normalizeInput(arg) : HOME_URL);
    sendDownloads();
    sendPasswords();
    sendVpn();
  });
  win.on('closed', () => {
    win = null;
    tabs = [];
  });
  // En pantalla completa se oculta toda la barra superior (lo maneja la interfaz)
  win.on('enter-full-screen', () => { send('fullscreen', true); setTimeout(layout, 50); });
  win.on('leave-full-screen', () => { send('fullscreen', false); setTimeout(layout, 50); });
}

function buildMenu() {
  const wc = () => activeTab()?.view.webContents;
  const template = [
    {
      label: 'Navegador',
      submenu: [
        { label: 'Nueva pestaña', accelerator: 'CmdOrCtrl+T', click: () => { createTab(); focusAddress(); } },
        { label: 'Cerrar pestaña', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
        { label: 'Siguiente pestaña', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
        { label: 'Siguiente pestaña (flecha)', accelerator: 'CmdOrCtrl+Shift+Right', click: () => cycleTab(1) },
        { label: 'Pestaña anterior (flecha)', accelerator: 'CmdOrCtrl+Shift+Left', click: () => cycleTab(-1) },
        { label: 'Ver todas las pestañas', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => openTabOverview() },
        { label: 'Siguiente pestaña', accelerator: 'Ctrl+PageDown', visible: false, click: () => cycleTab(1) },
        { label: 'Pestaña anterior', accelerator: 'Ctrl+PageUp', visible: false, click: () => cycleTab(-1) },
        { type: 'separator' },
        { label: 'Atrás', accelerator: 'Alt+Left', click: () => wc()?.navigationHistory.goBack() },
        { label: 'Adelante', accelerator: 'Alt+Right', click: () => wc()?.navigationHistory.goForward() },
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => wc()?.reload() },
        { label: 'Recargar', accelerator: 'F5', visible: false, click: () => wc()?.reload() },
        { label: 'Ir a la barra de direcciones', accelerator: 'CmdOrCtrl+L', click: () => focusAddress() },
        { type: 'separator' },
        { label: 'Añadir/quitar favorito', accelerator: 'CmdOrCtrl+D', click: () => toggleBookmark() },
        { label: 'Favoritos', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('show-panel', 'bookmarks') },
        { label: 'Descargas', accelerator: 'CmdOrCtrl+J', click: () => send('show-panel', 'downloads') },
        { label: 'Contraseñas', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('show-panel', 'passwords') },
        { label: 'Antenas Ubiquiti', accelerator: 'CmdOrCtrl+Shift+U', click: () => send('show-panel', 'devices') },
        { type: 'separator' },
        { label: 'Ocultar/mostrar barra de direcciones', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('toggle-navbar') },
        { label: 'Pantalla completa', accelerator: 'F11', click: () => { if (win) win.setFullScreen(!win.isFullScreen()); } },
        { type: 'separator' },
        { label: 'Herramientas de desarrollo', accelerator: 'F12', click: () => wc()?.toggleDevTools() },
        { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toggleBookmark() {
  const tab = activeTab();
  if (!tab) return;
  const { url, title } = tabInfo(tab);
  if (!url) return;
  const existing = bookmarks.findIndex(b => b.url === url);
  if (existing >= 0) bookmarks.splice(existing, 1);
  else bookmarks.push({ url, title, favicon: tab.favicon });
  saveBookmarks(bookmarks);
  sendTabs();
}

function setupDownloads() {
  session.defaultSession.on('will-download', (_event, item) => {
    const dl = {
      id: nextDownloadId++,
      filename: item.getFilename(),
      url: item.getURL(),
      path: '',
      received: 0,
      total: item.getTotalBytes(),
      state: 'progressing',
    };
    downloads.unshift(dl);
    send('show-panel', 'downloads');

    // Guardar directamente en la carpeta de Descargas sin preguntar
    const dir = app.getPath('downloads');
    let target = path.join(dir, dl.filename);
    const { name, ext } = path.parse(dl.filename);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${name} (${n})${ext}`);
    item.setSavePath(target);
    dl.path = target;
    dl.filename = path.basename(target);

    item.on('updated', (_e, state) => {
      dl.received = item.getReceivedBytes();
      dl.total = item.getTotalBytes();
      dl.state = state === 'interrupted' ? 'interrupted' : (item.isPaused() ? 'paused' : 'progressing');
      sendDownloads();
    });
    item.once('done', (_e, state) => {
      dl.received = item.getReceivedBytes();
      dl.state = state; // completed | cancelled | interrupted
      downloadItems.delete(dl.id);
      sendDownloads();
    });
    downloadItems.set(dl.id, item);
    sendDownloads();
  });
}

// ---------- IPC desde la interfaz ----------
// Solo se aceptan mensajes de la interfaz del navegador, nunca de las páginas web
const ui = {
  on: (channel, fn) => ipcMain.on(channel, (e, ...args) => { if (win && e.sender === win.webContents) fn(e, ...args); }),
};

ui.on('navigate', (_e, input) => {
  const tab = activeTab();
  if (tab) tab.view.webContents.loadURL(normalizeInput(input));
});
ui.on('back', () => activeTab()?.view.webContents.navigationHistory.goBack());
ui.on('forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
ui.on('reload', () => {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.stop();
  else wc.reload();
});
ui.on('new-tab', (_e, url) => {
  if (url) {
    createTab(normalizeInput(url));
  } else {
    createTab();
    focusAddress();
  }
});
// Abrir un equipo en pestaña nueva, con autologin (desde la vista Antenas)
ui.on('open-device', (_e, { url, autologin }) => {
  createTab(normalizeInput(String(url || '')), true, { autologin: !!autologin });
});
ui.on('tab-overview', () => openTabOverview());
ui.on('toggle-fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ui.on('close-tab', (_e, id) => closeTab(id));
ui.on('activate-tab', (_e, id) => activateTab(id));
ui.on('toggle-bookmark', () => toggleBookmark());
ui.on('remove-bookmark', (_e, url) => {
  bookmarks = bookmarks.filter(b => b.url !== url);
  saveBookmarks(bookmarks);
  sendTabs();
});
ui.on('open-bookmark', (_e, url) => {
  const tab = activeTab();
  if (tab) tab.view.webContents.loadURL(url);
});
ui.on('panel', (_e, open) => {
  panelOpen = !!open;
  layout();
});
ui.on('chrome-height', (_e, h) => {
  chromeHeight = Math.max(0, Math.round(Number(h) || 0));
  layout();
});
ui.on('modal', (_e, open) => {
  modalOpen = !!open;
  layout();
  if (!modalOpen) activeTab()?.view.webContents.focus();
});
ui.on('download-action', (_e, { id, action }) => {
  const dl = downloads.find(d => d.id === id);
  if (!dl) return;
  const item = downloadItems.get(id);
  switch (action) {
    case 'open': shell.openPath(dl.path); break;
    case 'show': shell.showItemInFolder(dl.path); break;
    case 'cancel': item?.cancel(); break;
    case 'pause': item?.pause(); dl.state = 'paused'; sendDownloads(); break;
    case 'resume': if (item?.canResume()) item.resume(); dl.state = 'progressing'; sendDownloads(); break;
    case 'remove':
      item?.cancel();
      downloads = downloads.filter(d => d !== dl);
      sendDownloads();
      break;
  }
});
ui.on('clear-downloads', () => {
  downloads = downloads.filter(d => d.state === 'progressing' || d.state === 'paused');
  sendDownloads();
});

// ---------- Contraseñas ----------
function sendPasswords() {
  send('passwords', { entries: passwords.list(), presets: passwords.listPresets() });
  sendTabs();
}

// Guardadas para el sitio primero; después las predefinidas que correspondan a ese equipo
function credentialsFor(origin) {
  const saved = passwords.forOrigin(origin);
  let host = '';
  try { host = new URL(origin).hostname; } catch {}
  const presets = host ? passwords.presetsFor(host, isPrivateHost(host)) : [];
  return [...saved, ...presets.filter(p => !saved.some(s => s.username === p.username && s.password === p.password))];
}

// El origen se toma siempre del marco real que envía el mensaje, nunca de lo que diga la página
ipcMain.handle('pw:get', (e) => {
  const origin = originOf(e.senderFrame?.url);
  return origin ? credentialsFor(origin) : [];
});

ipcMain.on('pw:submitted', (e, credential) => {
  const tab = tabs.find(t => t.view.webContents === e.sender);
  const origin = originOf(e.senderFrame?.url);
  if (!tab || !origin || typeof credential?.password !== 'string' || !credential.password) return;
  const username = String(credential.username || '');
  // Si entró con una credencial predefinida no hace falta guardarla aparte
  if (credentialsFor(origin).some(c => c.preset && c.username === username && c.password === credential.password)) return;
  const status = passwords.status(origin, username, credential.password);
  if (status === 'same') {
    passwords.touch(origin, username);
    return;
  }
  if (passwords.isNever(origin)) return;
  tab.pwPrompt = { origin, username, password: credential.password, update: status === 'update' };
  sendTabs();
});

ui.on('pw-prompt', (_e, { tabId, action }) => {
  const tab = getTab(tabId);
  const prompt = tab?.pwPrompt;
  if (!prompt) return;
  tab.pwPrompt = null;
  if (action === 'save') passwords.save(prompt.origin, prompt.username, prompt.password);
  if (action === 'never') passwords.setNever(prompt.origin);
  sendPasswords();
});

const isPresetId = (id) => String(id).startsWith('preset:');

ui.on('pw-fill', (_e, id) => {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  if (isPresetId(id)) {
    // Predefinida: se rellena en el sitio que está abierto en la pestaña
    const credential = passwords.getPreset(id);
    const origin = originOf(wc.getURL());
    if (!credential || !origin) return;
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (originOf(frame.url) === origin) frame.send('pw:fill', credential);
    }
    return;
  }
  const credential = passwords.get(id);
  if (!credential) return;
  for (const frame of wc.mainFrame.framesInSubtree) {
    if (originOf(frame.url) === credential.origin) frame.send('pw:fill', credential);
  }
  passwords.touch(credential.origin, credential.username);
});

ui.on('pw-copy', (_e, id) => {
  const credential = isPresetId(id) ? passwords.getPreset(id) : passwords.get(id);
  if (credential) clipboard.writeText(credential.password);
});

ui.on('pw-remove', (_e, id) => {
  if (isPresetId(id)) passwords.removePreset(id);
  else passwords.remove(id);
  sendPasswords();
});

ui.on('preset-add', (_e, preset) => {
  if (!preset || !String(preset.password || '')) return;
  passwords.savePreset(preset);
  sendPasswords();
});

// ---------- Escaneo de antenas Ubiquiti ----------
let scanning = false;
let lastDevices = []; // último resultado del escaneo (para consultar señal/CCQ)

async function runScan(fn) {
  if (scanning) return;
  scanning = true;
  send('scan-state', { scanning: true });
  let devices = [];
  try { devices = await fn(); } catch {}
  lastDevices = devices;
  scanning = false;
  send('scan-state', { scanning: false });
  send('devices', devices);
  // Login automático para toda la red: al terminar el escaneo se consulta el estado solo
  if (devices.length) fetchAllStatus();
}

ui.on('scan-devices', () => runScan(() => discovery.scan(3000)));
// Barrido por subred/rango (unicast): sirve con broadcast filtrado y a través de túnel VPN.
// Si el túnel WireGuard está conectado, el sondeo se hace por el túnel (el ayudante manda la
// consulta UDP desde dentro del túnel); si no, se hace directo desde esta PC.
ui.on('scan-range', (_e, spec) => runScan(() => {
  const text = String(spec || '');
  const st = vpn.getState();
  // Con WireGuard el barrido sale por el ayudante (dentro del túnel userspace). Con OpenVPN/PPTP
  // el sistema ya enruta hacia el túnel, así que el barrido normal (unicast) desde esta PC sirve.
  if (st.status === 'connected' && st.protocol === 'wireguard') {
    return vpn.discover(discovery.parseTargets(text), discovery.parseReply);
  }
  return discovery.scanRange(text, 5000);
}));

// Todas las credenciales conocidas para un equipo (guardadas http/https + predefinidas), sin repetir.
function credsForDevice(ip) {
  const all = [...credentialsFor(`https://${ip}`), ...credentialsFor(`http://${ip}`)];
  const seen = new Set();
  const list = [];
  for (const c of all) {
    const key = `${c.username}\n${c.password}`;
    if (!seen.has(key)) { seen.add(key); list.push({ username: c.username, password: c.password }); }
  }
  if (!list.length) list.push({ username: 'ubnt', password: 'ubnt' });
  return list;
}

// Entra a cada equipo (probando todas las credenciales conocidas) y trae señal, CCQ, etc.
let fetchingStatus = false;

async function fetchAllStatus() {
  if (fetchingStatus || !lastDevices.length) return;
  fetchingStatus = true;
  send('status-state', { fetching: true });
  await Promise.all(lastDevices.map(async (d) => {
    let result;
    try {
      result = await status.fetchStatus(d.ip, credsForDevice(d.ip), isPrivateHost);
    } catch (e) {
      result = { ok: false, error: String(e) };
    }
    send('device-status', { key: d.mac || d.ip, status: result });
  }));
  fetchingStatus = false;
  send('status-state', { fetching: false });
}

ui.on('fetch-device-status', () => fetchAllStatus());

// ---------- Cliente VPN WireGuard (solo para el navegador) ----------
let vpnProxyOn = false;

function applyVpnProxy(on) {
  // El túnel afecta solo al navegador: se enruta su tráfico (y las consultas de señal) por el
  // proxy SOCKS5 del ayudante. localhost queda excluido (lo bypassa Chromium), así el control
  // del ayudante y la interfaz siguen siendo directos.
  if (on === vpnProxyOn) return;
  vpnProxyOn = on;
  const cfg = on ? { proxyRules: `socks5://127.0.0.1:${vpn.SOCKS_PORT}` } : { mode: 'direct' };
  session.defaultSession.setProxy(cfg);
  status.setProxy(on ? cfg : null);
}

function sendVpn() {
  const state = vpn.getState();
  // El proxy SOCKS solo aplica al túnel WireGuard (userspace). OpenVPN/PPTP los enruta el sistema.
  applyVpnProxy(state.status === 'connected' && state.protocol === 'wireguard');
  send('vpn', { profiles: vpn.listProfiles(), state, available: vpn.helperAvailable() });
}

vpn.init(sendVpn);

ui.on('vpn-save', (_e, profile) => { vpn.saveProfile(profile || {}); sendVpn(); });
ui.on('vpn-remove', (_e, id) => {
  const state = vpn.getState();
  if (state.profileId === id && state.status !== 'idle') vpn.disconnect();
  vpn.removeProfile(id);
  sendVpn();
});
ui.on('vpn-connect', (_e, id) => vpn.connect(id));
ui.on('vpn-disconnect', () => vpn.disconnect());

// ---------- Certificados de equipos de la red interna ----------
// Routers, ONUs y antenas (p. ej. LiteBeam 5AC Gen2) sirven su panel por https con un
// certificado propio (autofirmado), que Chromium normalmente rechaza. Aquí se aceptan
// SOLO cuando el equipo está en una dirección de red interna (192.168.x, 10.x, 172.16-31.x,
// 100.64.x CGNAT, 169.254.x, localhost y nombres .local/.lan). En Internet NO se acepta
// ningún certificado inválido: ahí se mantiene la verificación normal del navegador.
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (host && isPrivateHost(host)) {
    event.preventDefault(); // confiar en el certificado del equipo de la red interna
    callback(true);
  } else {
    callback(false);        // Internet: se rechaza como en cualquier navegador
  }
});

// ---------- Autenticación HTTP ----------
// La ventanita de usuario/contraseña que usan muchos routers y ONUs
const authRequests = new Map(); // id -> { callback, origin, isProxy }
const authAttempts = new Map(); // `${wcId}|${origin}` -> cuántas credenciales conocidas ya se probaron
let nextAuthId = 1;

function clearAuthAttempts(wcId) {
  for (const key of authAttempts.keys()) if (key.startsWith(wcId + '|')) authAttempts.delete(key);
}

app.on('login', (event, webContents, details, authInfo, callback) => {
  event.preventDefault();
  const origin = originOf(details.url) || `${authInfo.scheme}://${authInfo.host}:${authInfo.port}`;
  const saved = authInfo.isProxy ? [] : credentialsFor(origin);
  const key = `${webContents?.id}|${origin}`;
  const tried = authAttempts.get(key) || 0;

  // Probar sin preguntar las credenciales conocidas (guardadas y predefinidas), una por intento
  if (tried < saved.length) {
    authAttempts.set(key, tried + 1);
    callback(saved[tried].username, saved[tried].password);
    return;
  }

  const id = nextAuthId++;
  authRequests.set(id, { callback, origin, isProxy: authInfo.isProxy });
  const tab = tabs.find(t => t.view.webContents === webContents);
  if (tab && tab.id !== activeId) activateTab(tab.id);
  send('auth-request', {
    id,
    origin,
    realm: authInfo.realm || '',
    isProxy: authInfo.isProxy,
    username: saved[0]?.username || '',
    failed: tried > 0,
  });
  authAttempts.set(key, tried + 1);
});

ui.on('auth-response', (_e, { id, username, password, remember }) => {
  const request = authRequests.get(id);
  if (!request) return;
  authRequests.delete(id);
  if (username === undefined) {
    request.callback(); // cancelado
    return;
  }
  if (remember && !request.isProxy) {
    passwords.save(request.origin, String(username), String(password));
    sendPasswords();
  }
  request.callback(String(username), String(password));
});

// ---------- Arranque ----------
app.whenReady().then(() => {
  bookmarks = loadBookmarks();
  passwords.load();
  vpn.load();
  buildMenu();
  setupDownloads();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { try { vpn.disconnect(); } catch {} });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
