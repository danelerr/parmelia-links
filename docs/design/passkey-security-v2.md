# Passkey Security v2 — alcance, metadata y opciones

**Estado:** desplegado en App Worker y App Web; aceptación WebAuthn manual pendiente

**Fecha:** 30 de agosto de 2026
**Alcance:** App Worker y App Web; no modifica Payments, Dashboard ni contratos

## Decisiones

1. El RP ID deja de derivarse del hostname del navegador. El App Worker entrega
   `rpId` en cada challenge de registro y en cada UserOperation preparada.
2. El RP ID actual permanece en `app.parmelia.me` para no invalidar las
   credenciales ya creadas. Cambiar hosting, API o proveedor no lo cambia.
3. `PASSKEY_RP_ID` y `PASSKEY_ALLOWED_ORIGINS` son configuración pública del
   Worker, no Secrets ni variables `VITE_*`. Deben existir explícitamente en
   cada entorno; un origen debe ser el RP ID o un subdominio suyo. Producción
   rechaza HTTP, `localhost` y loopback.
4. WebAuthn tiene su propia allowlist. Agregar Dashboard, previews o checkout a
   CORS no autoriza crear credenciales allí.
5. La autorización continúa dependiendo exclusivamente de la clave P-256
   verificada y del signer onchain. AAGUID, proveedor, tipo de dispositivo y
   respaldo son metadata de administración y nunca una política de seguridad.

## Registro

```text
App Web                App Worker                     Authenticator
   |  preflight + Origin   |                               |
   |---------------------->| valida origen/RP ID           |
   |<----------------------| challenge, rpId, exclusions   |
   | WebAuthn create(rpId, mode, excludeCredentials)        |
   |------------------------------------------------------->|
   |<-------------------------------------------------------|
   | attestation + public key                               |
   |---------------------->| verifica challenge/origin/RP   |
   |                       | guarda clave y metadata        |
```

El modo principal solicita el dispositivo o gestor integrado. «Otras opciones»
permite pedir una llave física (`cross-platform`) sin convertir esa decisión en
un paso obligatorio. El navegador o sistema operativo conserva la decisión
final sobre Google Password Manager, Apple Passwords, Windows Hello u otro
gestor disponible.

## Datos persistidos

La migración `0036_passkey_security_metadata.sql` añade a la ceremonia y al
registro canónico:

- `rp_id` / `expected_rp_id`;
- `aaguid` y etiqueta de proveedor de mejor esfuerzo;
- `credential_device_type` (`singleDevice` o `multiDevice`);
- `credential_backed_up` (BE/BS verificado por WebAuthn);
- `authenticator_attachment` (`platform` o `cross-platform`);
- fecha de actualización de metadata.

La UI debe usar lenguaje de incertidumbre cuando un dato sea nulo. Con
`attestation: none`, el AAGUID puede estar ausente o anonimizado. Aunque exista,
no demuestra por sí solo qué gestor custodia la llave.

## Sincronización con gestores

La App usa la WebAuthn Signal API sólo como mejora compatible:

- actualiza nombre/displayName de la identidad cuando el navegador lo soporta;
- informa una credencial eliminada únicamente después de confirmación onchain;
- envía `allAcceptedCredentialIds` sólo si el servidor demostró una
  correspondencia uno-a-uno entre todas las credenciales D1 y todos los signers
  activos onchain.

Una lista parcial nunca se envía: omitir una credencial válida podría ocultarla
en el gestor del usuario. La falta de Signal API o cualquier error del gestor no
bloquea operaciones.

## Retorno a la operación

Pagar, cambiar, enviar y ahorrar siguen mostrando un único CTA hacia
`Configuración → Seguridad` cuando no pueden usar una llave. El destino de
retorno se conserva sólo si es una ruta relativa del mismo origen. Se rechazan
URLs absolutas, `//`, barras invertidas, caracteres de control y bucles hacia la
misma pantalla. El retorno es explícito; nunca se redirige automáticamente tras
crear una llave.

## Orden de publicación

Este candidato no autoriza una publicación. En una ventana App-only aprobada:

1. crear y verificar backup cifrado de App D1;
2. comprobar el listado remoto de migraciones;
3. aplicar únicamente `0036_passkey_security_metadata.sql`;
4. desplegar App Worker con `PASSKEY_RP_ID=app.parmelia.me` y
   `PASSKEY_ALLOWED_ORIGINS=https://app.parmelia.me`;
5. comprobar preflight/registro/status en el origen real;
6. desplegar App Web;
7. probar una llave integrada y, con hardware disponible, una llave física;
8. conservar rollback del Worker/Web, sin intentar revertir columnas D1.

El entrypoint del Worker bloquea automáticamente cualquier migración App local
que no aparezca aplicada en la D1 remota, comprueba columnas/restricciones/índice
de Passkey v2 y rechaza un RP/origen distinto del contrato estable. El preflight
de solo lectura inspecciona cada versión que recibe tráfico; no considera
promovido el candidato mientras `0036`, su esquema semántico o cualquiera de
ambos bindings públicos siga pendiente.

## Cambio futuro a GatoPago

DNS no migra passkeys. Una credencial de `app.parmelia.me` no sirve para un RP ID
distinto como `app.gatopago.com`. Antes del cambio se necesita un periodo de
coexistencia en el origen actual, alta de una llave nueva bajo el RP ID nuevo,
prueba de firma, medición de cobertura y rollback. Hasta completar ese plan,
`app.parmelia.me` y su dominio de continuidad deben conservarse.

## Evidencia local requerida

- migración completa y constraints en workerd/D1;
- verificación real de challenge, origin, RP ID, AAGUID, BE y BS;
- tests de allowlist WebAuthn separada de CORS;
- cliente TypeScript/lint/build;
- navegador desktop/mobile para información, opciones, accesibilidad y
  `returnTo` adversarial;
- `pnpm verify:all` antes de declarar el candidato publicable.

La matriz se ejecutó el 30 de agosto de 2026 sobre este candidato y terminó con
exit `0`: App Worker 265 unitarias + 26 runtime, Payments 52 + 23, Playwright 60
aprobadas/40 omisiones deliberadas, backup/restore de 60 tablas D1, audit sin
vulnerabilidades conocidas y 191 pruebas Foundry finales aprobadas/4 forks
omitidos por no inyectar RPC. Después se aplicó `0036`, se promovieron App Worker
`a2ea1d70-0553-48fd-8501-201bfe7e5143` y App Web
`parmelia-4ezj8lobg-danelerrs-projects.vercel.app`, y el preflight remoto terminó
con 12 checks listos. Una ceremonia real no se simula: requiere la sesión, el
autenticador y el gesto del usuario.

Referencias primarias:

- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [Chrome WebAuthn Signal API](https://developer.chrome.com/docs/identity/webauthn-signal-api)
- [Google passkey user journeys](https://developers.google.com/identity/passkeys/ux/user-journeys)
