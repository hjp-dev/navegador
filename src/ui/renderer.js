const $ = (id) => document.getElementById(id);

const state = { tabs: [], activeId: null, bookmarks: [], downloads: [], panel: null };

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
}

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
  } else {
    $('panel-title').textContent = 'Descargas';
    $('panel-clear').hidden = !state.downloads.some(d => !['progressing', 'paused'].includes(d.state));
    empty.textContent = 'No hay descargas.';
    list.replaceChildren(...state.downloads.map(renderDownload));
    empty.hidden = state.downloads.length > 0;
  }
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
  if (state.panel === 'bookmarks') renderPanel();
});

browser.on('downloads', (downloads) => {
  state.downloads = downloads;
  if (state.panel === 'downloads') renderPanel();
  else if (downloads.some(d => d.state === 'progressing')) $('dl-badge').hidden = false;
});

browser.on('show-panel', (name) => {
  if (state.panel !== name) openPanel(name);
});

browser.on('focus-address', focusAddress);
