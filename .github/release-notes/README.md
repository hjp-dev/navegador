# Notas de versión

El workflow de **Instaladores** publica el Release tomando el cuerpo (descripción) desde el
archivo `.github/release-notes/<etiqueta>.md` correspondiente a la etiqueta que se publica.

- Al publicar con la etiqueta `v1.4.0`, el workflow usa `.github/release-notes/v1.4.0.md`.
- Si ese archivo **no existe**, pone un texto por defecto («Instaladores de v1.4.0.») para no fallar.

Así que, para que un próximo Release salga con notas: **agrega `v<versión>.md` en esta carpeta**
(en la rama desde la que se publica) antes de disparar el workflow con esa etiqueta.
