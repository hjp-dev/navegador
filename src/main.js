const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const HOME_URL = 'https://www.google.com';
const SEARCH_URL = 'https://www.google.com/search?q=';
const TOOLBAR_HEIGHT = 76; // barra de pestañas + barra de navegación
const PANEL_WIDTH = 320;   // panel lateral de favoritos/descargas

let win;
let tabs = [];          // { id, view }
let activeId = null;
let nextTabId = 1;
let panelOpen = false;

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

function normalizeInput(input) {
  const text = input.trim();
  if (!text) return HOME_URL;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;            // ya tiene esquema
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return 'http://' + text;
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
  return {
    id: tab.id,
    title: wc.getTitle() || 'Nueva pestaña',
    url: wc.getURL(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    favicon: tab.favicon || null,
  };
}

function sendTabs() {
  send('tabs', { tabs: tabs.map(tabInfo), activeId, bookmarks });
}

function layout() {
  const tab = activeTab();
  if (!win || !tab) return;
  const [width, height] = win.getContentSize();
  const w = panelOpen ? Math.max(0, width - PANEL_WIDTH) : width;
  tab.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

// ---------- Pestañas ----------
function createTab(url = HOME_URL, activate = true) {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const tab = { id: nextTabId++, view, favicon: null };
  tabs.push(tab);

  const wc = view.webContents;
  const update = () => sendTabs();
  wc.on('page-title-updated', update);
  wc.on('did-start-loading', update);
  wc.on('did-stop-loading', update);
  wc.on('did-navigate', update);
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

  wc.loadURL(url);
  if (activate) activateTab(tab.id);
  else sendTabs();
  return tab;
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
  });
  win.on('closed', () => {
    win = null;
    tabs = [];
  });
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
        { label: 'Pestaña anterior', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
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
ipcMain.on('navigate', (_e, input) => {
  const tab = activeTab();
  if (tab) tab.view.webContents.loadURL(normalizeInput(input));
});
ipcMain.on('back', () => activeTab()?.view.webContents.navigationHistory.goBack());
ipcMain.on('forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
ipcMain.on('reload', () => {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.stop();
  else wc.reload();
});
ipcMain.on('new-tab', (_e, url) => {
  if (url) {
    createTab(normalizeInput(url));
  } else {
    createTab();
    focusAddress();
  }
});
ipcMain.on('close-tab', (_e, id) => closeTab(id));
ipcMain.on('activate-tab', (_e, id) => activateTab(id));
ipcMain.on('toggle-bookmark', () => toggleBookmark());
ipcMain.on('remove-bookmark', (_e, url) => {
  bookmarks = bookmarks.filter(b => b.url !== url);
  saveBookmarks(bookmarks);
  sendTabs();
});
ipcMain.on('open-bookmark', (_e, url) => {
  const tab = activeTab();
  if (tab) tab.view.webContents.loadURL(url);
});
ipcMain.on('panel', (_e, open) => {
  panelOpen = !!open;
  layout();
});
ipcMain.on('download-action', (_e, { id, action }) => {
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
ipcMain.on('clear-downloads', () => {
  downloads = downloads.filter(d => d.state === 'progressing' || d.state === 'paused');
  sendDownloads();
});

// ---------- Arranque ----------
app.whenReady().then(() => {
  bookmarks = loadBookmarks();
  buildMenu();
  setupDownloads();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
