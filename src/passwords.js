// Almacén de contraseñas guardadas (cifradas con el llavero del sistema cuando está disponible:
// DPAPI en Windows, gnome-keyring/kwallet en Ubuntu, Keychain en macOS).
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'contrasenas.json');

// entries: contraseñas guardadas por sitio { id, origin, username, password, enc, lastUsed }
// presets: credenciales predefinidas para equipos de la red interna { id, label, username, password, enc, hosts }
//          hosts: IPs/nombres separados por comas, admite * (p. ej. "10.0.*"); vacío = toda la red interna
let data = { entries: [], never: [], presets: [] };

const FACTORY_PRESETS = [
  { label: 'Ubiquiti airOS (fábrica)', username: 'ubnt', password: 'ubnt', hosts: '192.168.1.20, 192.168.172.1' },
];

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  data = { entries: [], never: [], ...stored };
  if (!Array.isArray(data.presets)) {
    // Primera vez: se cargan las credenciales de fábrica conocidas
    data.presets = FACTORY_PRESETS.map(p => ({ id: newId(), label: p.label, username: p.username, hosts: p.hosts, ...encrypt(p.password) }));
    persist();
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
    entry = { id: newId(), origin, username };
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

// ---------- Credenciales predefinidas ----------
function hostMatches(patterns, host, isPrivate) {
  const list = String(patterns || '').split(/[\s,;]+/).filter(Boolean);
  if (list.length === 0) return isPrivate; // sin IPs: cualquier equipo de la red interna
  return list.some(p => new RegExp('^' + p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(host.toLowerCase()));
}

function presetsFor(host, isPrivate) {
  return data.presets
    .filter(p => hostMatches(p.hosts, host, isPrivate))
    .map(p => ({ id: 'preset:' + p.id, username: p.username, password: decrypt(p), preset: true, label: p.label }));
}

function listPresets() {
  return data.presets.map(({ id, label, username, hosts }) => ({ id: 'preset:' + id, label, username, hosts }));
}

function getPreset(id) {
  const preset = data.presets.find(p => 'preset:' + p.id === id);
  return preset && { username: preset.username, password: decrypt(preset) };
}

function savePreset({ label, username, password, hosts }) {
  data.presets.push({ id: newId(), label: String(label || ''), username: String(username || ''), hosts: String(hosts || ''), ...encrypt(String(password || '')) });
  persist();
}

function removePreset(id) {
  data.presets = data.presets.filter(p => 'preset:' + p.id !== id);
  persist();
}

module.exports = {
  load, list, forOrigin, get, status, save, touch, remove, isNever, setNever,
  presetsFor, listPresets, getPreset, savePreset, removePreset,
};
