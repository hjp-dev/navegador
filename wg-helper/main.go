// wg-helper: túnel WireGuard en espacio de usuario (sin root ni driver) para el
// navegador. Expone un proxy SOCKS5 local cuyo tráfico TCP sale por el túnel y
// un pequeño servidor HTTP de control con /status y /discover (barrido Ubiquiti
// por UDP a través del túnel). También genera claves (genkey / pubkey).
//
// El túnel vive solo mientras corre este proceso: es "solo para el navegador",
// no toca la configuración de red del equipo. Electron lo lanza, apunta la
// sesión al SOCKS5 y lo mata al desconectar.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	socks5 "github.com/armon/go-socks5"
	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Config es el JSON que Electron escribe en un archivo temporal y pasa con -config.
type Config struct {
	PrivateKey string   `json:"privateKey"`
	Address    string   `json:"address"` // IP del cliente dentro del túnel, p. ej. 10.9.0.2
	DNS        []string `json:"dns"`
	MTU        int      `json:"mtu"`
	Socks      string   `json:"socks"`   // dirección local del proxy SOCKS5
	Control    string   `json:"control"` // dirección local del HTTP de control
	Peer       struct {
		PublicKey    string   `json:"publicKey"`
		PresharedKey string   `json:"presharedKey"`
		Endpoint     string   `json:"endpoint"` // host:puerto del MikroTik/servidor
		AllowedIPs   []string `json:"allowedIPs"`
		Keepalive    int      `json:"keepalive"`
	} `json:"peer"`
}

func b64ToHex(s string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return "", err
	}
	if len(b) != 32 {
		return "", fmt.Errorf("clave de %d bytes, se esperaban 32", len(b))
	}
	return hex.EncodeToString(b), nil
}

// clamp aplica el recorte de bits estándar de Curve25519/WireGuard.
func clamp(k []byte) { k[0] &= 248; k[31] = (k[31] & 127) | 64 }

func genKey() (priv, pub string, err error) {
	var k [32]byte
	if _, err = rand.Read(k[:]); err != nil {
		return
	}
	clamp(k[:])
	p, err := curve25519.X25519(k[:], curve25519.Basepoint)
	if err != nil {
		return
	}
	return base64.StdEncoding.EncodeToString(k[:]), base64.StdEncoding.EncodeToString(p), nil
}

func pubFromPriv(privB64 string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(privB64))
	if err != nil || len(b) != 32 {
		return "", fmt.Errorf("clave privada inválida")
	}
	p, err := curve25519.X25519(b, curve25519.Basepoint)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(p), nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func main() {
	// Subcomando genkey: imprime {privateKey, publicKey} en JSON.
	if len(os.Args) >= 2 && os.Args[1] == "genkey" {
		priv, pub, err := genKey()
		if err != nil {
			fail(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"privateKey": priv, "publicKey": pub})
		return
	}
	// Subcomando pubkey <priv>: deriva la pública.
	if len(os.Args) >= 3 && os.Args[1] == "pubkey" {
		pub, err := pubFromPriv(os.Args[2])
		if err != nil {
			fail(err)
		}
		fmt.Println(pub)
		return
	}

	// Modo túnel: -config <archivo>
	var cfgPath string
	for i := 1; i < len(os.Args)-1; i++ {
		if os.Args[i] == "-config" {
			cfgPath = os.Args[i+1]
		}
	}
	if cfgPath == "" {
		fmt.Fprintln(os.Stderr, "uso: wg-helper -config <archivo> | genkey | pubkey <priv>")
		os.Exit(2)
	}
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		fail(err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		fail(err)
	}
	if cfg.MTU == 0 {
		cfg.MTU = 1420
	}

	localAddr, err := netip.ParseAddr(strings.TrimSpace(cfg.Address))
	if err != nil {
		fail(fmt.Errorf("dirección del cliente inválida: %v", err))
	}
	var dns []netip.Addr
	for _, d := range cfg.DNS {
		if a, e := netip.ParseAddr(strings.TrimSpace(d)); e == nil {
			dns = append(dns, a)
		}
	}
	if len(dns) == 0 {
		dns = append(dns, netip.MustParseAddr("1.1.1.1"))
	}

	tun, tnet, err := netstack.CreateNetTUN([]netip.Addr{localAddr}, dns, cfg.MTU)
	if err != nil {
		fail(err)
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg: "))

	privHex, err := b64ToHex(cfg.PrivateKey)
	if err != nil {
		fail(fmt.Errorf("clave privada: %v", err))
	}
	pubHex, err := b64ToHex(cfg.Peer.PublicKey)
	if err != nil {
		fail(fmt.Errorf("clave pública del peer: %v", err))
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "private_key=%s\n", privHex)
	fmt.Fprintf(&sb, "public_key=%s\n", pubHex)
	if cfg.Peer.PresharedKey != "" {
		ph, e := b64ToHex(cfg.Peer.PresharedKey)
		if e != nil {
			fail(fmt.Errorf("preshared key: %v", e))
		}
		fmt.Fprintf(&sb, "preshared_key=%s\n", ph)
	}
	if cfg.Peer.Endpoint != "" {
		fmt.Fprintf(&sb, "endpoint=%s\n", cfg.Peer.Endpoint)
	}
	ka := cfg.Peer.Keepalive
	if ka == 0 {
		ka = 25
	}
	fmt.Fprintf(&sb, "persistent_keepalive_interval=%d\n", ka)
	allowed := cfg.Peer.AllowedIPs
	if len(allowed) == 0 {
		allowed = []string{"0.0.0.0/0"}
	}
	for _, a := range allowed {
		fmt.Fprintf(&sb, "allowed_ip=%s\n", strings.TrimSpace(a))
	}
	if err := dev.IpcSet(sb.String()); err != nil {
		fail(err)
	}
	if err := dev.Up(); err != nil {
		fail(err)
	}

	// Proxy SOCKS5: cada conexión TCP se marca por el túnel (tnet.DialContext).
	sconf := &socks5.Config{
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return tnet.DialContext(ctx, network, addr)
		},
	}
	sserver, err := socks5.New(sconf)
	if err != nil {
		fail(err)
	}
	socksAddr := cfg.Socks
	if socksAddr == "" {
		socksAddr = "127.0.0.1:25345"
	}
	go func() {
		if err := sserver.ListenAndServe("tcp", socksAddr); err != nil {
			fmt.Fprintln(os.Stderr, "socks:", err)
		}
	}()

	// HTTP de control.
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		s, _ := dev.IpcGet()
		var last, rx, tx int64
		for _, line := range strings.Split(s, "\n") {
			if strings.HasPrefix(line, "last_handshake_time_sec=") {
				fmt.Sscanf(line, "last_handshake_time_sec=%d", &last)
			} else if strings.HasPrefix(line, "rx_bytes=") {
				fmt.Sscanf(line, "rx_bytes=%d", &rx)
			} else if strings.HasPrefix(line, "tx_bytes=") {
				fmt.Sscanf(line, "tx_bytes=%d", &tx)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"up": last > 0, "lastHandshake": last, "rx": rx, "tx": tx,
		})
	})
	// /discover?targets=ip1,ip2,...  → sondea UDP 10001 por el túnel y devuelve
	// las respuestas crudas (base64) para que el lado Node las parsee igual que
	// el descubrimiento local.
	mux.HandleFunc("/discover", func(w http.ResponseWriter, r *http.Request) {
		targets := strings.Split(r.URL.Query().Get("targets"), ",")
		probe := []byte{0x01, 0x00, 0x00, 0x00}
		type res struct {
			IP   string `json:"ip"`
			Data string `json:"data"`
		}
		var mu sync.Mutex
		out := []res{}
		var wg sync.WaitGroup
		sem := make(chan struct{}, 128)
		for _, t := range targets {
			t = strings.TrimSpace(t)
			if t == "" {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(ip string) {
				defer wg.Done()
				defer func() { <-sem }()
				c, err := tnet.Dial("udp", ip+":10001")
				if err != nil {
					return
				}
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(2 * time.Second))
				if _, err := c.Write(probe); err != nil {
					return
				}
				buf := make([]byte, 2048)
				n, err := c.Read(buf)
				if err != nil || n <= 4 {
					return
				}
				mu.Lock()
				out = append(out, res{IP: ip, Data: base64.StdEncoding.EncodeToString(buf[:n])})
				mu.Unlock()
			}(t)
		}
		wg.Wait()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	ctrlAddr := cfg.Control
	if ctrlAddr == "" {
		ctrlAddr = "127.0.0.1:25346"
	}
	srv := &http.Server{Addr: ctrlAddr, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintln(os.Stderr, "control:", err)
		}
	}()

	fmt.Println("wg-helper listo socks=" + socksAddr + " control=" + ctrlAddr)
	// Terminar cuando Electron cierre stdin (o mate el proceso).
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = dev.Down()
	dev.Close()
}
