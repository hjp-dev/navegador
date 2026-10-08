// Túneles VPN gestionados por el sistema operativo: OpenVPN y PPTP.
//
// A diferencia de WireGuard (que corre en espacio de usuario y afecta SOLO al navegador),
// OpenVPN y PPTP necesitan una interfaz de red del sistema. Por eso aquí NO se levanta el túnel a
// mano: se le pide al gestor de red del propio sistema operativo, que además maneja la elevación
// de permisos con su diálogo (polkit en Linux, el usuario en Windows):
//   - Linux (Ubuntu): NetworkManager vía `nmcli` (requiere los plugins
//     network-manager-openvpn / network-manager-pptp).
//   - Windows: la VPN integrada (`Add-VpnConnection` + `rasdial`) para PPTP; para OpenVPN se usa
//     el cliente OpenVPN instalado.
// Consecuencia: mientras está conectado, el túnel afecta a TODA la PC, no solo al navegador.
//
// Como el enrutado lo hace el sistema, el descubrimiento de antenas por subred funciona con el
// barrido normal (unicast) desde esta PC; no hace falta el ayudante SOCKS del WireGuard.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const conName = (id) => `navegador-${id}`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 45000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), failed: !!err });
    });
  });
}

const tmpFile = (name) => path.join(app.getPath('temp'), name);

// ---------- Linux (NetworkManager / nmcli) ----------
async function nmDelete(id) { await run('nmcli', ['connection', 'delete', conName(id)]); }

async function linuxConnectOpenvpn(profile, secrets) {
  const name = conName(profile.id);
  const file = tmpFile(`${name}.ovpn`);
  fs.writeFileSync(file, secrets.ovpnConfig || '', { mode: 0o600 });
  await nmDelete(profile.id);
  // nmcli importa y nombra la conexión según el nombre del archivo (= name)
  let r = await run('nmcli', ['connection', 'import', 'type', 'openvpn', 'file', file]);
  try { fs.unlinkSync(file); } catch {}
  if (r.failed) return { ok: false, error: nmError(r, 'openvpn') };
  if (secrets.username) await run('nmcli', ['connection', 'modify', name, '+vpn.data', `username=${secrets.username}`]);
  if (secrets.password) {
    await run('nmcli', ['connection', 'modify', name, '+vpn.data', 'password-flags=0']);
    await run('nmcli', ['connection', 'modify', name, 'vpn.secrets', `password=${secrets.password}`]);
  }
  r = await run('nmcli', ['connection', 'up', name], { timeout: 60000 });
  if (r.failed) { await nmDelete(profile.id); return { ok: false, error: nmError(r, 'openvpn') }; }
  return { ok: true };
}

async function linuxConnectPptp(profile, secrets) {
  const name = conName(profile.id);
  await nmDelete(profile.id);
  // MPPE obligatorio y solo MS-CHAPv2 (lo más seguro posible dentro de lo inseguro que es PPTP)
  const data = [
    `gateway=${profile.gateway || ''}`,
    `user=${secrets.username || ''}`,
    'require-mppe=yes', 'refuse-eap=yes', 'refuse-pap=yes', 'refuse-chap=yes', 'refuse-mschap=yes',
  ].join(', ');
  let r = await run('nmcli', ['connection', 'add', 'type', 'vpn', 'vpn-type', 'pptp', 'con-name', name, '--', 'vpn.data', data]);
  if (r.failed) return { ok: false, error: nmError(r, 'pptp') };
  if (secrets.password) {
    await run('nmcli', ['connection', 'modify', name, '+vpn.data', 'password-flags=0']);
    await run('nmcli', ['connection', 'modify', name, 'vpn.secrets', `password=${secrets.password}`]);
  }
  r = await run('nmcli', ['connection', 'up', name], { timeout: 60000 });
  if (r.failed) { await nmDelete(profile.id); return { ok: false, error: nmError(r, 'pptp') }; }
  return { ok: true };
}

function nmError(r, kind) {
  const msg = (r.stderr || r.stdout || '').trim();
  if (/not found|no such|Unknown connection|command not found/i.test(msg) && /import|vpn-type/i.test(msg + kind)) {
    return `Falta el plugin de NetworkManager para ${kind}. En Ubuntu: sudo apt install network-manager-${kind} (y network-manager-${kind}-gnome). Detalle: ${msg}`;
  }
  if (!msg) return 'nmcli no está disponible. Instala NetworkManager (nmcli).';
  return msg;
}

async function linuxActive(id) {
  const r = await run('nmcli', ['-t', '-f', 'NAME', 'connection', 'show', '--active']);
  return r.stdout.split('\n').map(s => s.trim()).includes(conName(id));
}

async function linuxDisconnect(id) {
  await run('nmcli', ['connection', 'down', conName(id)]);
  await nmDelete(id); // no dejar secretos guardados en NetworkManager
}

// ---------- Windows (VPN integrada / rasdial / cliente OpenVPN) ----------
const ps = (script) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);

async function winConnectPptp(profile, secrets) {
  const name = conName(profile.id);
  // Conexión VPN de usuario (no requiere admin). -Force la reemplaza si ya existe.
  let r = await ps(`Add-VpnConnection -Name '${name}' -ServerAddress '${(profile.gateway || '').replace(/'/g, "''")}' -TunnelType Pptp -AuthenticationMethod MSChapv2 -EncryptionLevel Required -RememberCredential -Force`);
  if (r.failed) return { ok: false, error: (r.stderr || r.stdout || 'No se pudo crear la conexión PPTP.').trim() };
  r = await run('rasdial', [name, secrets.username || '', secrets.password || ''], { timeout: 60000 });
  if (r.failed) return { ok: false, error: (r.stdout || r.stderr || 'rasdial no pudo conectar.').trim() };
  return { ok: true };
}

function winFindOpenvpn() {
  const cands = [
    'C:/Program Files/OpenVPN/bin/openvpn.exe',
    'C:/Program Files (x86)/OpenVPN/bin/openvpn.exe',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'openvpn'; // confiar en el PATH
}

let winOvpnProc = null;
async function winConnectOpenvpn(profile, secrets) {
  const name = conName(profile.id);
  const file = tmpFile(`${name}.ovpn`);
  fs.writeFileSync(file, secrets.ovpnConfig || '', { mode: 0o600 });
  const bin = winFindOpenvpn();
  // OpenVPN en Windows necesita permisos de administrador para crear el adaptador TAP/Wintun.
  return await new Promise((resolve) => {
    try {
      winOvpnProc = require('child_process').spawn(bin, ['--config', file], { windowsHide: true });
      let err = '';
      let ok = false;
      winOvpnProc.stdout.on('data', (d) => { if (/Initialization Sequence Completed/i.test(String(d))) { ok = true; resolve({ ok: true }); } });
      winOvpnProc.stderr.on('data', (d) => { err += String(d); });
      winOvpnProc.on('error', (e) => resolve({ ok: false, error: `No se encontró OpenVPN. Instala el cliente OpenVPN. (${e.message})` }));
      winOvpnProc.on('exit', (code) => { try { fs.unlinkSync(file); } catch {} if (!ok) resolve({ ok: false, error: (err.trim().split('\n').pop() || `OpenVPN terminó (código ${code}). ¿Ejecutaste el navegador como administrador?`) }); });
      setTimeout(() => { if (!ok) resolve({ ok: true, pending: true }); }, 15000); // dar tiempo al handshake
    } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
  });
}

async function winDisconnect(profile) {
  if (winOvpnProc) { try { winOvpnProc.kill(); } catch {} winOvpnProc = null; }
  await run('rasdial', [conName(profile.id), '/disconnect']);
}

async function winActive(id) {
  if (winOvpnProc) return true;
  const r = await run('rasdial', []);
  return new RegExp(conName(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(r.stdout);
}

// ---------- API ----------
async function connect(profile, secrets) {
  const win = process.platform === 'win32';
  if (profile.protocol === 'openvpn') return win ? winConnectOpenvpn(profile, secrets) : linuxConnectOpenvpn(profile, secrets);
  if (profile.protocol === 'pptp') return win ? winConnectPptp(profile, secrets) : linuxConnectPptp(profile, secrets);
  return { ok: false, error: 'protocolo no soportado por el gestor del sistema' };
}

async function disconnect(profile) {
  if (process.platform === 'win32') return winDisconnect(profile);
  return linuxDisconnect(profile.id);
}

async function isActive(id) {
  return process.platform === 'win32' ? winActive(id) : linuxActive(id);
}

module.exports = { connect, disconnect, isActive };
