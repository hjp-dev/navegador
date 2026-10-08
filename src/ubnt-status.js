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
let pendingProxy = null; // proxy a aplicar (túnel VPN); se recuerda hasta crear la sesión

// Sesión aislada con aceptación del certificado propio SOLO en red interna (igual que el navegador).
function getSession(isPrivateHost) {
  if (statusSession) return statusSession;
  statusSession = session.fromPartition('ubnt-status');
  statusSession.setCertificateVerifyProc((req, callback) => {
    callback(isPrivateHost(req.hostname) ? 0 : -3); // 0 = confiar; -3 = verificación normal de Chromium
  });
  if (pendingProxy) statusSession.setProxy(pendingProxy);
  return statusSession;
}

// Enruta las consultas de estado por el túnel VPN (o vuelve a conexión directa con null/{}).
function setProxy(config) {
  pendingProxy = config || null;
  if (statusSession) statusSession.setProxy(config || { mode: 'direct' });
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
  const stations = Array.isArray(w.sta) ? w.sta : [];

  // Señal:
  //  - airOS 6: w.signal
  //  - airOS 8: no está en w.signal; viene por enlace en w.sta[].signal
  //             (CPE en modo estación = w.sta[0]; AP = se toma la mejor de sus clientes)
  let signal = (w.signal != null) ? w.signal : null;
  if (signal == null && stations.length) {
    signal = stations.reduce((best, s) => (s && s.signal != null && (best == null || s.signal > best) ? s.signal : best), null);
  }

  // CCQ existe en airOS 6 (w.ccq). airOS 8 no lo reporta -> queda null.
  const ccq = normCcq(w.ccq);

  // Throughput (airOS 8 lo trae en w.throughput, en kbps)
  const tp = w.throughput || {};
  const sta0 = stations[0] || {};
  const polling = w.polling || {};
  const remote = w.remote || {};
  const airmax = w.airmax || {};
  const gps = remote.gps || json.gps || {};

  return {
    ok: true,
    scheme,
    signal,                            // dBm
    ccq,                               // % (solo airOS 6)
    essid: w.essid || '',
    mode: w.mode || '',
    rxrate: w.rxrate ?? null,
    txrate: w.txrate ?? null,
    txthroughput: tp.tx ?? null,       // kbps (airOS 8)
    rxthroughput: tp.rx ?? null,       // kbps (airOS 8)
    distance: w.distance ?? null,
    noise: (w.noisef ?? null),
    txpower: (w.txpower ?? null),
    frequency: w.frequency ?? null,    // MHz
    peers: stations.length || (w.count ?? null),
    uptime: h.uptime ?? null,
    fwversion: h.fwversion || '',
    hostname: h.hostname || '',
    devmodel: h.devmodel || '',
    temperature: h.temperature ?? null,
    // --- Datos extra de airOS 8 ---
    dlCapacity: polling.dl_capacity ?? null,  // kbps
    ulCapacity: polling.ul_capacity ?? null,  // kbps
    dlSignalExpect: sta0.dl_signal_expect ?? null, // dBm
    ulSignalExpect: sta0.ul_signal_expect ?? null, // dBm
    cinrRx: airmax.rx?.cinr ?? null,
    cinrTx: airmax.tx?.cinr ?? null,
    remoteName: remote.hostname || '',
    remotePlatform: remote.platform || '',
    remoteSignal: remote.signal ?? null,       // dBm (señal del equipo del otro lado)
    gpsLat: (gps.lat != null && gps.lat !== '') ? gps.lat : null,
    gpsLon: (gps.lon != null && gps.lon !== '') ? gps.lon : null,
  };
}

// credsOrList: una credencial { username, password } o una lista (se prueban en orden).
async function fetchStatus(ip, credsOrList, isPrivateHost) {
  const ses = getSession(isPrivateHost);
  const creds = (Array.isArray(credsOrList) ? credsOrList : [credsOrList]).filter(c => c && c.username != null);
  let lastError = 'sin respuesta';
  for (const scheme of ['http', 'https']) {
    const base = `${scheme}://${ip}`;
    try {
      // 1) Reutilizar el login que ya hizo el usuario en el navegador, si lo hay
      await reuseLoginCookies(ses, base);
      try {
        const res = await httpRequest(ses, 'GET', `${base}/status.cgi`);
        if (res.status === 200) {
          const parsed = tryParse(res.body, scheme);
          if (parsed) return parsed;
        }
      } catch (e) { lastError = `status.cgi: ${e.message || e}`; }

      // 2) Si no había sesión válida, probar cada credencial hasta que una entre
      for (const cred of creds) {
        try {
          await httpRequest(ses, 'GET', `${base}/login.cgi`).catch(() => {});
          await httpRequest(ses, 'POST', `${base}/login.cgi`, form({ username: cred.username, password: cred.password, uri: '/' }));
          const res2 = await httpRequest(ses, 'GET', `${base}/status.cgi`);
          const parsed = tryParse(res2.body, scheme);
          if (parsed) { parsed.user = cred.username; return parsed; }
          lastError = `login falló (${cred.username})`;
        } catch (e) { lastError = String(e.message || e); }
      }
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
  }
  return { ok: false, error: lastError };
}

// Devuelve el estado si el cuerpo es el JSON de status.cgi; null si es otra cosa (p. ej. login HTML).
function tryParse(body, scheme) {
  try { return parseStatus(body, scheme); } catch { return null; }
}

module.exports = { fetchStatus, setProxy };
