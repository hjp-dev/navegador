# Navegador

Navegador web minimalista basado en Chromium (usando [Electron](https://www.electronjs.org/)).
Solo tiene lo indispensable:

- **Pestañas**: abrir, cerrar (también con clic central) y cambiar entre ellas. Los enlaces que abren ventana nueva se abren en una pestaña.
- **Atrás / Adelante / Recargar** y barra de direcciones (escribe una URL o busca en Google).
- **Favoritos**: la estrella ☆ de la barra añade o quita la página actual; el botón ★ abre la lista. Se guardan en `favoritos.json` dentro de la carpeta de datos de la app.
- **Descargas**: se guardan en tu carpeta de Descargas; el panel ⤓ muestra el progreso y permite pausar, reanudar, cancelar, abrir el archivo o mostrarlo en la carpeta.

## Pensado para redes internas (routers, ONUs, OLTs)

- **Sin avisos de "sitio no seguro"**: las páginas `http://` de los equipos se abren sin advertencias.
- **Direcciones directas**: al escribir `192.168.1.1`, `10.0.0.1:8080`, `router.lan`, etc. se abre
  `http://…` directamente, en vez de buscar en Google o forzar https.
- **Guardar usuario y contraseña**:
  - Al iniciar sesión en un formulario aparece la barra *¿Guardar la contraseña…?*.
    La próxima vez se rellena sola.
  - Funciona también con la ventanita de usuario/contraseña del propio equipo (autenticación HTTP):
    marca *Recordar usuario y contraseña* y la próxima vez entra sin preguntar.
  - Varias cuentas para la misma IP (por ejemplo, ONUs distintas en `192.168.1.1`): abre el panel 🔑
    (Ctrl+Shift+P) y pulsa **Rellenar** en la que quieras. Desde ahí también se puede copiar o eliminar.
  - Las contraseñas se guardan en `contrasenas.json`, cifradas con el sistema (Windows: DPAPI;
    Ubuntu: llavero de GNOME/KDE). Si el sistema no tiene llavero disponible se guardan sin cifrar.

## Uso

Necesitas [Node.js](https://nodejs.org/) 18 o superior.

```bash
npm install
npm start                    # abre la página de inicio
npm start -- wikipedia.org   # abre una URL concreta
```

### Descargar los instaladores

Cada vez que se suben cambios a GitHub, la acción **Instaladores** genera los instaladores para
Windows y Ubuntu. Para descargarlos: pestaña **Actions** del repositorio → última ejecución de
*Instaladores* → sección **Artifacts**:

- `Navegador-Setup-Windows`: contiene `Navegador Setup x.y.z.exe`.
- `Navegador-Ubuntu`: contiene `navegador_x.y.z_amd64.deb` y `Navegador-x.y.z.AppImage`.

Si subes una etiqueta (`git tag v1.0.0 && git push --tags`), los instaladores se publican
también en la sección **Releases**.

#### Windows

Ejecuta el `.exe`. Windows puede mostrar el aviso de SmartScreen porque el instalador no está
firmado: pulsa *Más información* → *Ejecutar de todas formas*.

#### Ubuntu (20.04 o superior)

Instala el paquete `.deb` (recomendado) desde una terminal en la carpeta donde lo descargaste:

```bash
sudo apt install ./navegador_1.0.0_amd64.deb
```

Queda en el menú de aplicaciones como **Navegador** (y se abre con `navegador` desde la terminal).
Para desinstalarlo: `sudo apt remove navegador`.

En Ubuntu 23.10 y posteriores el paquete instala además un perfil de AppArmor
(`/etc/apparmor.d/navegador`), igual que hacen Chrome o VS Code, para que el aislamiento
de seguridad de Chromium funcione.

Alternativa sin instalar: el `.AppImage` se ejecuta directamente
(`chmod +x Navegador-1.0.0.AppImage && ./Navegador-1.0.0.AppImage`). En Ubuntu 22.04 o
posteriores necesita `sudo apt install libfuse2` (en 24.04: `libfuse2t64`).

### Crear un ejecutable localmente

```bash
npm run dist   # genera un instalador en dist/ (AppImage, .exe o .dmg según tu sistema)
```

## Atajos de teclado

| Acción | Atajo |
| --- | --- |
| Nueva pestaña | Ctrl+T |
| Cerrar pestaña | Ctrl+W |
| Siguiente / anterior pestaña | Ctrl+Tab / Ctrl+Shift+Tab |
| Atrás / Adelante | Alt+← / Alt+→ |
| Recargar | Ctrl+R o F5 |
| Ir a la barra de direcciones | Ctrl+L |
| Añadir/quitar favorito | Ctrl+D |
| Ver favoritos | Ctrl+Shift+O |
| Ver descargas | Ctrl+J |
| Contraseñas guardadas | Ctrl+Shift+P |

(En macOS usa Cmd en lugar de Ctrl.)

## Estructura

```
src/
  main.js          Proceso principal: ventana, pestañas, favoritos, descargas e inicio de sesión
  passwords.js     Almacén cifrado de contraseñas
  preload.js       Puente seguro entre la interfaz y el proceso principal
  page-preload.js  Se ejecuta en las páginas: detecta y rellena formularios de inicio de sesión
  ui/            Interfaz (barra de pestañas, navegación y panel lateral)
```
