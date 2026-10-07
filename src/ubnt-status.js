// Lee el estado (señal, CCQ, etc.) de un equipo airOS entrando a su interfaz web.
// El discovery (UDP) no trae señal ni CCQ: eso solo se obtiene en /status.cgi del equipo.
//
// Estrategia:
//  1) Reutilizar la sesión que el usuario YA abrió en el navegador (su cookie de login). Así,
//     si ya entró a la antena, no hace falta volver a autenticar (sirve aunque la contraseña
//     no sea la de fábrica).
//  2) Si no hay sesión, intentar login (GET /login.cgi para la cookie, POST /login.cgi con
//     usuario/clave) y volver a pedir /status.cgi.
// El status.cgi devuelve JSON con host.{fwversion,uptime} y wireless.{signal,ccq,essid,mode,...}.
const { net, session } = require('electron');

let statusSession = null;

// Sesión aislada con aceptación del certificado propio SOLO en red interna (igual que el navegador).
function getSession(isPrivateHost) {
  if (statusSession) return statusSession;
  statusSession = session.fromPartition('ubnt-status');
  statusSession.setCertificateVerifyProc((req, callback) => {
    callback(isPrivateHost(req.hostname) ? 0 : -3); // 0 = confiar; -3 = verificación normal de Chromium
  });
  return statusSession;
}

function httpRequest(ses, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url, session: ses, useSessionCookies: true, redirect: 'follow' });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    const timer = setTimeout(() => { try { req.abort(); } catch {} reject(new Error('timeout')); }, 6000);
    req.on('close', () => clearTimeout(timer));
    if (body != null) {
      req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      req.write(body);
    }
    req.end();
  });
}

const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// airOS da CCQ a veces en milésimas (0-1000) y a veces en % (0-100); se normaliza a %.
function normCcq(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return n > 100 ? Math.round(n / 10) : Math.round(n);
}

// Copia al cliente de estado las cookies que el navegador ya tenga para ese origen (login hecho).
async function reuseLoginCookies(ses, origin) {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    for (const c of cookies) {
      await ses.cookies.set({
        url: origin, name: c.name, value: c.value, path: c.path || '/',
        secure: !!c.secure, httpOnly: !!c.httpOnly,
      }).catch(() => {});
    }
    return cookies.length;
  } catch { return 0; }
}

function parseStatus(bodyText, scheme) {
  const json = JSON.parse(bodyText); // si es la página de login (HTML), lanza y se maneja afuera
  const w = json.wireless || {};
  const h = json.host || {};
  return {
    ok: true,
    scheme,
    signal: (w.signal ?? null),       // dBm
    ccq: normCcq(w.ccq),              // %
    essid: w.essid || '',
    mode: w.mode || '',
    rxrate: w.rxrate ?? null,
    txrate: w.txrate ?? null,
    distance: w.distance ?? null,
    noise: (w.noisef ?? null),
    txpower: (w.txpower ?? null),
    uptime: h.uptime ?? null,
    fwversion: h.fwversion || '',
    hostname: h.hostname || '',
    devmodel: h.devmodel || '',
  };
}

async function fetchStatus(ip, creds, isPrivateHost) {
  const ses = getSession(isPrivateHost);
  let lastError = 'sin respuesta';
  for (const scheme of ['http', 'https']) {
    const base = `${scheme}://${ip}`;
    try {
      // 1) Reutilizar el login que ya hizo el usuario en el navegador
      await reuseLoginCookies(ses, base);
      try {
        const res = await httpRequest(ses, 'GET', `${base}/status.cgi`);
        if (res.status === 200) return parseStatus(res.body, scheme);
      } catch (e) { lastError = `status.cgi: ${e.message || e}`; }

      // 2) Si no había sesión válida, intentar iniciar sesión con las credenciales
      if (creds && creds.username != null) {
        await httpRequest(ses, 'GET', `${base}/login.cgi`).catch(() => {});
        await httpRequest(ses, 'POST', `${base}/login.cgi`, form({ username: creds.username, password: creds.password, uri: '/' }));
        const res2 = await httpRequest(ses, 'GET', `${base}/status.cgi`);
        if (res2.status === 200) return parseStatus(res2.body, scheme);
        lastError = `status.cgi HTTP ${res2.status}`;
      }
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
  }
  return { ok: false, error: lastError };
}

module.exports = { fetchStatus };
