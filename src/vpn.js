// Cliente VPN WireGuard "solo para el navegador".
//
// El túnel corre en espacio de usuario dentro de un proceso auxiliar (wg-helper, escrito en Go
// con wireguard-go + netstack): NO crea interfaces de red ni toca la configuración del equipo,
// así que no necesita permisos de administrador ni drivers. El ayudante expone:
//   - un proxy SOCKS5 local: el navegador manda su tráfico TCP por ahí y sale por el túnel;
//   - un HTTP de control con /status (handshake) y /discover (barrido Ubiquiti por el túnel).
// Al desconectar se mata el proceso y el túnel desaparece. Por eso el túnel afecta solo al
// navegador, no a la PC donde corre: justo lo que se pedía para llegar a antenas detrás de un
// MikroTik configurando el túnel únicamente en el navegador.
//
// Las claves privadas se guardan cifradas con el llavero del sistema (igual que las contraseñas).
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const systemTunnel = require('./system-tunnel');

const SOCKS_PORT = 25345;
const CONTROL_PORT = 25346;

const file = () => path.join(app.getPath('userData'), 'vpn.json');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// profile guardado: { id, name, enc, privateKey, publicKey, address, dns, endpoint,
//                     peerPublicKey, presharedKey, pskEnc, allowedIPs, keepalive, mtu }
let data = { profiles: [] };
let onState = () => {};
let proc = null;
let pollTimer = null;
let sysPollTimer = null;
let state = { status: 'idle', profileId: null, protocol: null, socks: null, control: null, handshake: 0, error: '' };

function load() {
  try { data = { profiles: [], ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { data = { profiles: [] }; }
  if (!Array.isArray(data.profiles)) data.profiles = [];
}
function persist() { fs.writeFileSync(file(), JSON.stringify(data, null, 2)); }
function init(cb) { if (typeof cb === 'function') onState = cb; }

function encrypt(text) {
  text = String(text || '');
  if (text && safeStorage.isEncryptionAvailable()) {
    return { value: safeStorage.encryptString(text).toString('base64'), enc: true };
  }
  return { value: text, enc: false };
}
function decrypt(value, enc) {
  if (!enc) return value || '';
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
}

// ---------- Ubicación del binario auxiliar ----------
function helperPath() {
  const bin = process.platform === 'win32' ? 'wg-helper.exe' : 'wg-helper';
  const cands = [];
  if (process.env.WG_HELPER) cands.push(process.env.WG_HELPER);
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'wg-helper', bin));
  cands.push(path.join(__dirname, '..', 'build', 'wg-helper', process.platform, bin));
  cands.push(path.join(__dirname, '..', 'wg-helper', bin));
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return null;
}
const helperAvailable = () => !!helperPath();

// ---------- Generación de claves ----------
// Usa el ayudante (claves WireGuard estándar) y, si no está, Curve25519 con Node.
function genKeyPair() {
  const bin = helperPath();
  if (bin) {
    try {
      const out = execFileSync(bin, ['genkey'], { timeout: 5000 }).toString();
      const j = JSON.parse(out);
      if (j.privateKey && j.publicKey) return j;
    } catch {}
  }
  const kp = crypto.generateKeyPairSync('x25519');
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') };
}

// ---------- Perfiles ----------
// Vista para la interfaz: sin secretos (sí la clave pública de WireGuard, para pegarla en el peer).
function sanitize(p) {
  return {
    id: p.id, name: p.name, protocol: p.protocol || 'wireguard',
    // WireGuard
    publicKey: p.publicKey, address: p.address, dns: p.dns,
    endpoint: p.endpoint, peerPublicKey: p.peerPublicKey, allowedIPs: p.allowedIPs,
    keepalive: p.keepalive, mtu: p.mtu, hasPreshared: !!p.presharedKey,
    // OpenVPN / PPTP (sistema)
    gateway: p.gateway, username: p.username, hasConfig: !!p.ovpnConfig, hasPassword: !!p.password,
  };
}
function listProfiles() { return data.profiles.map(sanitize); }

// Crea o actualiza un perfil según su protocolo.
function saveProfile(input) {
  const p = input || {};
  let profile = p.id && data.profiles.find(x => x.id === p.id);
  const proto = (p.protocol || (profile && profile.protocol) || 'wireguard');
  if (!profile) { profile = { id: newId() }; data.profiles.push(profile); }
  profile.protocol = proto;
  profile.name = String(p.name || 'Túnel');

  if (proto === 'wireguard') {
    profile.address = String(p.address || '').trim();
    profile.dns = String(p.dns || '').trim();
    profile.endpoint = String(p.endpoint || '').trim();
    profile.peerPublicKey = String(p.peerPublicKey || '').trim();
    profile.allowedIPs = String(p.allowedIPs || '').trim();
    profile.keepalive = Number(p.keepalive) || 25;
    profile.mtu = Number(p.mtu) || 1420;
    // Claves: se regeneran si lo pide, o si el perfil aún no tiene ninguna.
    if (p.regenerate || !profile.privateKey) {
      const kp = genKeyPair();
      const encPriv = encrypt(kp.privateKey);
      profile.privateKey = encPriv.value;
      profile.enc = encPriv.enc;
      profile.publicKey = kp.publicKey;
    }
    if (p.presharedKey !== undefined) {
      const psk = String(p.presharedKey || '').trim();
      if (psk) { const e = encrypt(psk); profile.presharedKey = e.value; profile.pskEnc = e.enc; }
      else { delete profile.presharedKey; delete profile.pskEnc; }
    }
  } else {
    // OpenVPN / PPTP: túnel gestionado por el sistema
    profile.gateway = String(p.gateway || '').trim();
    profile.username = String(p.username || '').trim();
    if (p.password !== undefined && String(p.password) !== '') {
      const e = encrypt(String(p.password)); profile.password = e.value; profile.pwEnc = e.enc;
    }
    if (proto === 'openvpn' && p.ovpnConfig !== undefined && String(p.ovpnConfig).trim() !== '') {
      const e = encrypt(String(p.ovpnConfig)); profile.ovpnConfig = e.value; profile.ovpnEnc = e.enc;
    }
  }
  persist();
  return profile.id;
}

function removeProfile(id) {
  data.profiles = data.profiles.filter(p => p.id !== id);
  persist();
}

function getState() { return { ...state }; }

function setState(patch) { state = { ...state, ...patch }; onState(); }

// ---------- Conexión ----------
function connect(id) {
  const profile = data.profiles.find(p => p.id === id);
  if (!profile) { setState({ status: 'error', error: 'perfil no encontrado' }); return; }
  const proto = profile.protocol || 'wireguard';
  if (proto !== 'wireguard') return connectSystem(profile);
  const bin = helperPath();
  if (!bin) { setState({ status: 'error', error: 'El componente del túnel (wg-helper) no está disponible en esta instalación.' }); return; }
  disconnect();

  const cfg = {
    privateKey: decrypt(profile.privateKey, profile.enc),
    address: String(profile.address || '').split('/')[0].trim(), // el helper quiere solo la IP
    dns: profile.dns ? profile.dns.split(/[\s,]+/).filter(Boolean) : [],
    mtu: profile.mtu || 1420,
    socks: `127.0.0.1:${SOCKS_PORT}`,
    control: `127.0.0.1:${CONTROL_PORT}`,
    peer: {
      publicKey: profile.peerPublicKey,
      presharedKey: profile.presharedKey ? decrypt(profile.presharedKey, profile.pskEnc) : '',
      endpoint: profile.endpoint,
      allowedIPs: profile.allowedIPs ? profile.allowedIPs.split(/[\s,]+/).filter(Boolean) : ['0.0.0.0/0'],
      keepalive: profile.keepalive || 25,
    },
  };
  if (!cfg.privateKey || !cfg.address || !cfg.peer.publicKey || !cfg.peer.endpoint) {
    setState({ status: 'error', profileId: id, error: 'Faltan datos del perfil (dirección, endpoint o clave del peer).' });
    return;
  }

  const cfgPath = path.join(app.getPath('temp'), `navegador-wg-${process.pid}.json`);
  try { fs.writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 }); } catch (e) {
    setState({ status: 'error', profileId: id, error: String(e.message || e) }); return;
  }

  setState({ status: 'connecting', profileId: id, protocol: 'wireguard', socks: null, control: `127.0.0.1:${CONTROL_PORT}`, handshake: 0, error: '' });

  proc = spawn(bin, ['-config', cfgPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let started = false;
  proc.stdout.on('data', (d) => {
    if (!started && String(d).includes('listo')) {
      started = true;
      setState({ status: 'connected', profileId: id, socks: `127.0.0.1:${SOCKS_PORT}` });
      startPolling();
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += String(d); });
  proc.on('error', (e) => { setState({ status: 'error', profileId: id, error: String(e.message || e) }); cleanup(cfgPath); });
  proc.on('exit', (code) => {
    stopPolling();
    try { fs.unlinkSync(cfgPath); } catch {}
    proc = null;
    if (state.status !== 'idle') {
      // Salida inesperada = error; salida pedida por nosotros deja 'idle'.
      if (!started) setState({ status: 'error', profileId: id, socks: null, error: (stderr.trim().split('\n').pop() || `el túnel terminó (código ${code})`) });
      else if (state.status !== 'idle') setState({ status: 'idle', socks: null });
    }
  });
}

// ---------- Túneles del sistema (OpenVPN / PPTP) ----------
function connectSystem(profile) {
  const secrets = {
    username: profile.username || '',
    password: profile.password ? decrypt(profile.password, profile.pwEnc) : '',
    ovpnConfig: profile.ovpnConfig ? decrypt(profile.ovpnConfig, profile.ovpnEnc) : '',
  };
  if (profile.protocol === 'openvpn' && !secrets.ovpnConfig) {
    setState({ status: 'error', profileId: profile.id, protocol: 'openvpn', error: 'Falta la configuración .ovpn.' });
    return;
  }
  if (profile.protocol === 'pptp' && !profile.gateway) {
    setState({ status: 'error', profileId: profile.id, protocol: 'pptp', error: 'Falta el servidor (gateway) del PPTP.' });
    return;
  }
  setState({ status: 'connecting', profileId: profile.id, protocol: profile.protocol, socks: null, handshake: 0, error: '' });
  systemTunnel.connect(profile, secrets).then((r) => {
    if (state.profileId !== profile.id) return; // se canceló entretanto
    if (r.ok) { setState({ status: 'connected', profileId: profile.id, protocol: profile.protocol, handshake: 1 }); startSysPolling(profile); }
    else setState({ status: 'error', profileId: profile.id, protocol: profile.protocol, error: r.error || 'No se pudo conectar.' });
  }).catch((e) => setState({ status: 'error', profileId: profile.id, protocol: profile.protocol, error: String(e.message || e) }));
}

function startSysPolling(profile) {
  stopSysPolling();
  sysPollTimer = setInterval(async () => {
    try {
      const up = await systemTunnel.isActive(profile.id);
      if (!up && state.status === 'connected' && state.profileId === profile.id) {
        stopSysPolling();
        setState({ status: 'idle', profileId: null, protocol: null, error: '' });
      }
    } catch {}
  }, 5000);
}
function stopSysPolling() { if (sysPollTimer) { clearInterval(sysPollTimer); sysPollTimer = null; } }

function disconnect() {
  stopPolling();
  stopSysPolling();
  const current = state.profileId != null && (state.protocol === 'openvpn' || state.protocol === 'pptp')
    ? data.profiles.find(p => p.id === state.profileId) : null;
  if (proc) {
    const p = proc; proc = null;
    try { p.stdin.end(); } catch {}
    try { p.kill(); } catch {}
  }
  if (current) { systemTunnel.disconnect(current).catch(() => {}); }
  setState({ status: 'idle', profileId: null, protocol: null, socks: null, handshake: 0, error: '' });
}

function cleanup(cfgPath) { try { fs.unlinkSync(cfgPath); } catch {} }

// ---------- Estado del túnel (handshake) ----------
function controlGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CONTROL_PORT, path: pathname, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function startPolling() {
  stopPolling();
  const tick = async () => {
    try {
      const body = await controlGet('/status');
      const s = JSON.parse(body);
      setState({ handshake: s.lastHandshake || 0 });
    } catch {}
  };
  tick();
  pollTimer = setInterval(tick, 4000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---------- Barrido Ubiquiti a través del túnel ----------
// targets: lista de IPs ya calculada por ubnt-discovery.parseTargets.
// parseReply: ubnt-discovery.parseReply (inyectado para no acoplar módulos).
async function discover(targets, parseReply) {
  if (state.status !== 'connected') throw new Error('el túnel no está conectado');
  if (!targets.length) throw new Error('rango no válido');
  const found = new Map();
  // En tandas, para no mandar miles de IPs en una sola URL.
  for (let i = 0; i < targets.length; i += 256) {
    const slice = targets.slice(i, i + 256);
    let arr = [];
    try { arr = JSON.parse(await controlGet('/discover?targets=' + encodeURIComponent(slice.join(',')))); } catch {}
    for (const r of arr || []) {
      try {
        const d = parseReply(Buffer.from(r.data, 'base64'), r.ip);
        if (!d) continue;
        const key = d.mac || d.ip;
        const prev = found.get(key);
        if (prev) { for (const ip of d.ips) if (!prev.ips.includes(ip)) prev.ips.push(ip); }
        else found.set(key, d);
      } catch {}
    }
  }
  return [...found.values()];
}

module.exports = {
  load, init, listProfiles, saveProfile, removeProfile, genKeyPair,
  connect, disconnect, getState, discover, helperAvailable, SOCKS_PORT,
};
