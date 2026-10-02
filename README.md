# Navegador

Navegador web minimalista basado en Chromium (usando [Electron](https://www.electronjs.org/)).
Solo tiene lo indispensable:

- **Pestañas**: abrir, cerrar (también con clic central) y cambiar entre ellas. Los enlaces que abren ventana nueva se abren en una pestaña.
- **Atrás / Adelante / Recargar** y barra de direcciones (escribe una URL o busca en Google).
- **Favoritos**: la estrella ☆ de la barra añade o quita la página actual; el botón ★ abre la lista. Se guardan en `favoritos.json` dentro de la carpeta de datos de la app.
- **Descargas**: se guardan en tu carpeta de Descargas; el panel ⤓ muestra el progreso y permite pausar, reanudar, cancelar, abrir el archivo o mostrarlo en la carpeta.

## Uso

Necesitas [Node.js](https://nodejs.org/) 18 o superior.

```bash
npm install
npm start                    # abre la página de inicio
npm start -- wikipedia.org   # abre una URL concreta
```

### Crear un ejecutable

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

(En macOS usa Cmd en lugar de Ctrl.)

## Estructura

```
src/
  main.js        Proceso principal: ventana, pestañas, favoritos y descargas
  preload.js     Puente seguro entre la interfaz y el proceso principal
  ui/            Interfaz (barra de pestañas, navegación y panel lateral)
```
