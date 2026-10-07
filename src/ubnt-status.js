// Lee el estado (señal, CCQ, etc.) de un equipo airOS entrando a su interfaz web.
// El discovery (UDP) no trae señal ni CCQ: eso solo se obtiene iniciando sesión en el equipo.
// Flujo airOS (v6 y v8, best-effort): GET /login.cgi (cookie) → POST /login.cgi (usuario/clave)
// → GET /status.cgi (JSON). Se prueba primero http y, si falla, https.
const { net, session } = require('electron');

let statusSession = null;

// Sesión aislada para estas consultas. Acepta el certificado propio (autofirmado) SOLO en
// direcciones de red interna, igual que el resto del navegador; en Internet, verificación normal.
function getSession(isPrivateHost) {
  if (statusSession) return statusSession;
  statusSession = session.fromPartition('ubnt-status');
  statusSession.setCertificateVerifyProc((req, callback) => {
    callback(isPrivateHost(req.hostname) ? 0 : -3); // 0 = confiar; -3 = resultado normal de Chromium
  });
  return statusSession;
}

function request(ses, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url, session: ses, redirect: 'follow' });
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

async function fetchStatus(ip, creds, isPrivateHost) {
  const ses = getSession(isPrivateHost);
  let lastError = 'sin respuesta';
  for (const scheme of ['http', 'https']) {
    const base = `${scheme}://${ip}`;
    try {
      // 1) cookie de sesión  2) login  3) estado
      await request(ses, 'GET', `${base}/login.cgi`).catch(() => {});
      await request(ses, 'POST', `${base}/login.cgi`, form({ username: creds.username, password: creds.password, uri: '/' }));
      const res = await request(ses, 'GET', `${base}/status.cgi`);
      const json = JSON.parse(res.body);
      const w = json.wireless || {};
      return {
        ok: true,
        scheme,
        signal: (w.signal ?? null),             // dBm
        ccq: normCcq(w.ccq),                     // %
        essid: w.essid || '',
        mode: w.mode || '',
        rxrate: w.rxrate ?? null,
        txrate: w.txrate ?? null,
        distance: w.distance ?? null,
        uptime: json.host?.uptime ?? null,
        fwversion: json.host?.fwversion || '',
      };
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
  }
  return { ok: false, error: lastError };
}

module.exports = { fetchStatus };
