// Almacén de contraseñas guardadas (cifradas con el llavero del sistema cuando está disponible:
// DPAPI en Windows, gnome-keyring/kwallet en Ubuntu, Keychain en macOS).
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'contrasenas.json');

let data = { entries: [], never: [] }; // entries: { id, origin, username, password, enc, lastUsed }

function load() {
  try {
    data = { entries: [], never: [], ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    data = { entries: [], never: [] };
  }
}

function persist() {
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

function encrypt(text) {
  if (safeStorage.isEncryptionAvailable()) {
    return { password: safeStorage.encryptString(text).toString('base64'), enc: true };
  }
  return { password: text, enc: false };
}

function decrypt(entry) {
  if (!entry.enc) return entry.password;
  try {
    return safeStorage.decryptString(Buffer.from(entry.password, 'base64'));
  } catch {
    return '';
  }
}

// Lista sin contraseñas, para la interfaz
function list() {
  return data.entries
    .map(({ id, origin, username, lastUsed }) => ({ id, origin, username, lastUsed }))
    .sort((a, b) => a.origin.localeCompare(b.origin) || b.lastUsed - a.lastUsed);
}

// Credenciales de un origen, la usada más recientemente primero
function forOrigin(origin) {
  return data.entries
    .filter(e => e.origin === origin)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map(e => ({ id: e.id, username: e.username, password: decrypt(e) }));
}

function get(id) {
  const entry = data.entries.find(e => e.id === id);
  return entry && { origin: entry.origin, username: entry.username, password: decrypt(entry) };
}

// 'same' si ya está guardada igual, 'update' si cambia la contraseña de un usuario existente, 'new' si no existe
function status(origin, username, password) {
  const entry = data.entries.find(e => e.origin === origin && e.username === username);
  if (!entry) return 'new';
  return decrypt(entry) === password ? 'same' : 'update';
}

function save(origin, username, password) {
  let entry = data.entries.find(e => e.origin === origin && e.username === username);
  if (!entry) {
    entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), origin, username };
    data.entries.push(entry);
  }
  Object.assign(entry, encrypt(password), { lastUsed: Date.now() });
  data.never = data.never.filter(o => o !== origin);
  persist();
}

function touch(origin, username) {
  const entry = data.entries.find(e => e.origin === origin && e.username === username);
  if (entry) {
    entry.lastUsed = Date.now();
    persist();
  }
}

function remove(id) {
  data.entries = data.entries.filter(e => e.id !== id);
  persist();
}

const isNever = (origin) => data.never.includes(origin);

function setNever(origin) {
  if (!isNever(origin)) data.never.push(origin);
  persist();
}

module.exports = { load, list, forOrigin, get, status, save, touch, remove, isNever, setNever };
