// Descubrimiento de equipos Ubiquiti en la red local.
//
// Usa el mismo método que la herramienta oficial "Device Discovery" de Ubiquiti: el equipo
// envía una consulta por difusión (broadcast) en la red local y cada antena/radio Ubiquiti
// responde con sus datos (MAC, IP, firmware, modelo, nombre, SSID). Sirve para que un técnico
// localice los equipos de su propia red, incluso si su PC está en otra subred.
//
// Protocolo: UDP, puerto 10001. Consulta = 4 bytes (01 00 00 00). Respuesta en formato TLV
// (tipo, longitud, valor).
const dgram = require('dgram');
const os = require('os');

const PORT = 10001;
const PROBE = Buffer.from([0x01, 0x00, 0x00, 0x00]);

// Tipos de campo conocidos dentro de la respuesta
const TLV = {
  0x01: 'mac',          // dirección MAC (6 bytes)
  0x02: 'macip',        // MAC (6) + IP (4)
  0x03: 'firmware',     // versión de firmware (texto)
  0x0b: 'name',         // nombre del radio (texto)
  0x0c: 'model_short',  // modelo corto (texto)
  0x0d: 'essid',        // SSID (texto)
  0x14: 'model',        // modelo completo (texto)
};

const macStr = (buf) => [...buf].map(b => b.toString(16).padStart(2, '0')).join(':');
const ipStr = (buf) => [...buf].join('.');
const clean = (buf) => buf.toString('utf8').replace(/\0+$/, '').trim();

// Interpreta una respuesta UDP. Devuelve el equipo encontrado o null si el paquete no es válido.
// Un equipo en modo router reporta varias interfaces (LAN/gestión, WAN, etc.), cada una con su
// IP en un campo 0x02. Se recogen TODAS, no solo la primera.
function parseReply(msg, fromAddress) {
  // Cabecera: 01 00 + tamaño (2 bytes). Algunos firmwares usan una variante; se valida con tolerancia.
  if (msg.length < 4 || msg[0] !== 0x01) return null;
  const device = { address: fromAddress, mac: null, ip: fromAddress, ips: [], firmware: '', name: '', model: '', essid: '' };
  const addIp = (ip) => { if (ip && ip !== '0.0.0.0' && !device.ips.includes(ip)) device.ips.push(ip); };
  let offset = 4;
  while (offset + 3 <= msg.length) {
    const type = msg[offset];
    const len = msg.readUInt16BE(offset + 1);
    const start = offset + 3;
    if (start + len > msg.length) break;
    const value = msg.subarray(start, start + len);
    switch (TLV[type]) {
      case 'mac': if (!device.mac) device.mac = macStr(value); break;
      case 'macip':
        if (len >= 10) {
          if (!device.mac) device.mac = macStr(value.subarray(0, 6));
          addIp(ipStr(value.subarray(6, 10)));
        }
        break;
      case 'firmware': device.firmware = clean(value); break;
      case 'name': device.name = clean(value); break;
      case 'essid': device.essid = clean(value); break;
      case 'model': device.model = clean(value); break;
      case 'model_short': if (!device.model) device.model = clean(value); break;
    }
    offset = start + len;
  }
  // La IP por la que respondió (nuestra subred) va primero: es la que se abre por defecto.
  addIp(fromAddress);
  device.ips.sort((a, b) => (a === fromAddress ? -1 : b === fromAddress ? 1 : 0));
  device.ip = device.ips[0] || fromAddress;
  return device.mac || device.firmware || device.model ? device : null;
}

// Direcciones de difusión de las interfaces IPv4 de este equipo (sin loopback)
function broadcastAddresses() {
  const addrs = ['255.255.255.255'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      const bc = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
      if (!addrs.includes(bc)) addrs.push(bc);
    }
  }
  return addrs;
}

// Busca equipos durante `timeout` ms y devuelve la lista (sin repetir por MAC/IP).
function scan(timeout = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { socket.close(); } catch {}
      resolve([...found.values()]);
    };

    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      const device = parseReply(msg, rinfo.address);
      if (!device) return;
      const key = device.mac || device.ip;
      const prev = found.get(key);
      if (prev) {
        // Mismo equipo que respondió otra vez: se juntan las IPs que falten
        for (const ip of device.ips) if (!prev.ips.includes(ip)) prev.ips.push(ip);
      } else {
        found.set(key, device);
      }
    });

    socket.bind(() => {
      try { socket.setBroadcast(true); } catch {}
      const send = () => {
        if (done) return;
        for (const addr of broadcastAddresses()) {
          socket.send(PROBE, PORT, addr, () => {});
        }
      };
      send();
      setTimeout(send, 500);   // segundo envío por si se pierde el primero
      setTimeout(finish, timeout);
    });
  });
}

module.exports = { scan };
