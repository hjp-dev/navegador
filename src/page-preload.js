// Se ejecuta en cada página (y en cada iframe) de las pestañas, en un contexto aislado:
// la página no puede ver nada de esto. Detecta formularios de inicio de sesión para
// ofrecer guardar la contraseña y rellena las que ya están guardadas.
const { ipcRenderer } = require('electron');

const TEXT_TYPES = ['text', 'email', 'tel', 'number', ''];

function visible(input) {
  return !input.disabled && input.offsetParent !== null && input.getClientRects().length > 0;
}

// Busca el campo de contraseña y el de usuario (el último campo de texto antes de la contraseña)
function findLoginFields() {
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const passwords = inputs.filter(i => i.type === 'password');
  if (passwords.length === 0) return null;
  const password = passwords[0];
  let username = null;
  for (const input of inputs) {
    if (input === password) break;
    if (TEXT_TYPES.includes(input.type) && !input.readOnly) username = input;
  }
  return { password, username, count: passwords.length };
}

// Asigna el valor de forma que también lo detecten páginas hechas con React, Vue, etc.
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function fill({ username, password }, force) {
  const fields = findLoginFields();
  if (!fields) return false;
  // No rellenar formularios de cambio de contraseña (varios campos de contraseña)
  if (!force && fields.count > 1) return false;
  if (!force && fields.password.value) return false;
  if (fields.username && username) setValue(fields.username, username);
  setValue(fields.password, password);
  return true;
}

// ---------- Autorrelleno al cargar ----------
let autofilled = false;
let saved = null;

async function tryAutofill() {
  if (autofilled) return;
  if (!findLoginFields()) return;
  if (saved === null) saved = await ipcRenderer.invoke('pw:get').catch(() => []);
  if (saved.length && fill(saved[0], false)) autofilled = true;
}

function watchForms() {
  tryAutofill();
  // Muchos equipos dibujan el login con JavaScript después de cargar
  let pending = false;
  const observer = new MutationObserver(() => {
    if (autofilled || pending) return;
    pending = true;
    setTimeout(() => { pending = false; tryAutofill(); }, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  setTimeout(() => observer.disconnect(), 60000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchForms);
else watchForms();

// Relleno manual desde el panel de contraseñas
ipcRenderer.on('pw:fill', (_e, credential) => fill(credential, true));

// ---------- Autologin (abrir el equipo ya logueado desde la vista Antenas) ----------
// Envía el formulario de login una vez que está relleno. Sirve para airOS 6 (formulario normal)
// y airOS 8 (login dibujado con JS). Reintenta un rato por si el formulario tarda en aparecer.
let autoSubmitted = false;

function clickLoginButton() {
  const fields = findLoginFields();
  if (!fields) return false;
  // 1) Si el campo está dentro de un formulario, enviarlo
  const formEl = fields.password.form;
  if (formEl) {
    if (typeof formEl.requestSubmit === 'function') formEl.requestSubmit();
    else formEl.submit();
    return true;
  }
  // 2) Si no hay formulario (airOS 8), buscar un botón de login y pulsarlo
  const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], [onclick]')].filter(visible);
  const re = /\b(login|log ?in|ingresar|iniciar|entrar|acceder|sign ?in|aceptar|ok)\b/i;
  const btn = buttons.find(b => re.test((b.textContent || '') + ' ' + (b.value || '') + ' ' + (b.id || '')))
    || buttons.find(b => b.type === 'submit') || buttons[0];
  if (btn) { btn.click(); return true; }
  // 3) Último recurso: Enter en el campo de contraseña
  fields.password.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
  return true;
}

async function autoLogin() {
  if (autoSubmitted) return;
  const fields = findLoginFields();
  if (!fields) return; // todavía no apareció el login; se reintentará
  if (saved === null) saved = await ipcRenderer.invoke('pw:get').catch(() => []);
  if (!saved.length) { autoSubmitted = true; return; } // sin credenciales, no hay autologin
  fill(saved[0], true);
  setTimeout(() => { if (!autoSubmitted) { autoSubmitted = clickLoginButton(); } }, 250);
}

ipcRenderer.on('pw:autosubmit', () => {
  // Reintenta varias veces mientras no se haya enviado (login que tarda en dibujarse)
  let n = 0;
  const t = setInterval(() => { if (autoSubmitted || n++ > 12) clearInterval(t); else autoLogin(); }, 400);
  autoLogin();
});

// ---------- Detectar envío del login ----------
let lastSent = '';

function capture() {
  const fields = findLoginFields();
  if (!fields || fields.count > 1 || !fields.password.value) return;
  const credential = { username: fields.username?.value || '', password: fields.password.value };
  const key = JSON.stringify(credential);
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('pw:submitted', credential);
}

// Fase de captura: se lee antes de que la página procese (o borre/cifre) los campos
document.addEventListener('submit', capture, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) capture();
}, true);
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element && e.target.closest('button, input[type=submit], input[type=button], input[type=image], a, [onclick], [role=button]');
  if (target) capture();
}, true);
window.addEventListener('pagehide', capture);
