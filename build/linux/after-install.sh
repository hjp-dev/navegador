#!/bin/bash
# Script de post-instalación del paquete .deb (basado en el de electron-builder)

if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/navegador' -a -e '/usr/bin/navegador' -a "`readlink '/usr/bin/navegador'`" != '/etc/alternatives/navegador' ]; then
        rm -f '/usr/bin/navegador'
    fi
    update-alternatives --install '/usr/bin/navegador' 'navegador' '/opt/Navegador/navegador' 100 || ln -sf '/opt/Navegador/navegador' '/usr/bin/navegador'
else
    ln -sf '/opt/Navegador/navegador' '/usr/bin/navegador'
fi

# Ubuntu 23.10+ restringe los "user namespaces" con AppArmor, y sin ellos el sandbox de
# Chromium no arranca. Igual que Chrome o VS Code, se instala un perfil que se los permite.
APPARMOR_PROFILE_SOURCE='/opt/Navegador/resources/apparmor-profile'
APPARMOR_PROFILE_TARGET='/etc/apparmor.d/navegador'
if apparmor_status --enabled > /dev/null 2>&1 && [ -f "$APPARMOR_PROFILE_SOURCE" ] \
   && apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
        apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" || true
    fi
    chmod 0755 '/opt/Navegador/chrome-sandbox' || true
elif ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Sin user namespaces: usar chrome-sandbox con SUID
    chmod 4755 '/opt/Navegador/chrome-sandbox' || true
else
    chmod 0755 '/opt/Navegador/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
