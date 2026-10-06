#!/bin/bash
# Script de desinstalación del paquete .deb

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'navegador' '/opt/Navegador/navegador' || true
else
    rm -f '/usr/bin/navegador'
fi

APPARMOR_PROFILE_TARGET='/etc/apparmor.d/navegador'
if [ -f "$APPARMOR_PROFILE_TARGET" ]; then
    if hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove "$APPARMOR_PROFILE_TARGET" > /dev/null 2>&1 || true
    fi
    rm -f "$APPARMOR_PROFILE_TARGET"
fi
