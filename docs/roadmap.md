# Roadmap técnico de GatoPago

**Última revisión:** 24 de agosto de 2026
**Estado:** correcciones locales implementadas; quedan gates que dependen de producción o de proveedores
**Fuente inicial:** [auditoría técnica del 23 de agosto de 2026](./audits/2026-08-23.md)

Este archivo es la única lista de trabajo técnico. Un cambio local no demuestra que producción esté corregida: los puntos marcados como **local** todavía requieren commit, ejecución remota de CI y despliegue autorizado antes de validarse en los dominios reales.

## P0 — Requiere acción operativa antes del despliegue

- [ ] **Secretos locales (externo).** Sacar cualquier credencial operativa de OneDrive, revocar o rotar OIDC/Firebase y conservar únicamente archivos `.example` sin valores. No se inspeccionan ni rotan secretos desde este repositorio.
- [ ] **`user_event_outbox_dead` (producción).** Consultar solo identificador, tipo y error redactado; corregir y reintentar idempotentemente o cerrar como no entregable. El código y el runbook existen, pero la fila remota no puede considerarse resuelta desde pruebas locales.
- [ ] **Activar autenticación de seis dígitos (producción).** Aplicar, en orden, las migraciones `0030_email_otp.sql`, `0031_webauthn_registration.sql` y `0032_recovery_step_up.sql`; configurar el binding de email, remitente autorizado, Firebase Admin y `AUTH_CODE_PEPPER`. No aplicar estas migraciones antes de desplegar un Worker compatible.

## P1 — Implementado localmente

- [x] **Código de seis dígitos, sin enlaces de acceso.** El Worker genera y verifica OTP de un solo uso, entrega un Firebase Custom Token y el cliente inicia sesión con `signInWithCustomToken`. Los códigos se almacenan con hash, caducidad, límite de intentos y consumo atómico; Turnstile protege solicitud y verificación.
- [x] **CI reproducible en Node 24/Linux.** Node 24, pnpm congelado, Foundry, verificación integral, E2E y scanners están versionados; las Actions usan commits inmutables. Falta la primera ejecución remota porque aún no se ha hecho commit ni push.
- [x] **Cabeceras y health separado.** CSP y cabeceras defensivas están declaradas; `/health/live` es mínimo, `/health` expone solo estado agregado y `/health/ops` requiere el token operativo. Falta validar las respuestas del dominio real tras el deploy.
- [x] **Caché y service worker.** Chunks con hash son inmutables; HTML/manifest/SW se revalidan; las escrituras de Cache Storage se esperan y las rutas de Firebase Auth no se interceptan. El gate automatizado cubre instalación, fetch, invalidación y notificaciones.
- [x] **PWA y formulario de perfil.** La PWA usa únicamente la cara original de Meli en PNG, expone instalación desde navegador y conserva instrucciones para iOS. El perfil memoiza el modelo inicial para que nombre y red social no se reinicien durante la escritura; el selector de red usa estado controlado estable.
- [x] **Passkeys y recovery endurecidos.** Registro y verificación son server-bound con `@simplewebauthn/server`; las credenciales se pueden listar, renombrar y revocar. Recovery exige step-up, no consume el desafío en el preflight y lo consume atómicamente al proponer la recuperación.

## P2 — Mantenibilidad y cobertura

- [x] **Reducir hotspots por dominio.** `storage.ts` bajó de 3.159 a menos de 1.000 líneas y delega ledger, merchants/webhooks, passkeys, cross-chain, leases, cursores, operaciones de cuenta y features de usuario. `indexer.ts` bajó de 1.664 a menos de 750 líneas al separar los tres watchers. `ScanQR.tsx` y `PayPage.tsx` quedaron por debajo de 700 líneas mediante extracción de lógica y vistas.
- [x] **Unificar lógica sensible.** Esquemas EIP-712 y autorizaciones de pago viven en `shared`; los fixtures de TypeScript/Solidity comprueban la misma codificación. Los watchers comparten ventanas, finality, journal, reorg guards y cursores; el outbox permanece en la misma transacción que el cambio de estado correspondiente.
- [x] **Eliminar código muerto y deuda de efectos React.** Knip y el gate de ciclos pasan; `react-hooks/set-state-in-effect` es error, no warning. Se retiraron dependencias, assets PWA y exports sin consumidores solo después de comprobar su uso.
- [ ] **Flujos reales autenticados (producción).** Localmente hay E2E para OTP, perfil, selector de red, PWA, accesibilidad y rutas principales. Aún falta evidencia contra cuentas, APIs y chains reales de envío, swap, cross-chain, webhooks y recovery después del despliegue; un build local no cubre este punto.

## P3 — Rendimiento, dependencias y mainnet

- [ ] **Core Web Vitals de producción.** `sileo` se eliminó, Analytics/Firebase Analytics se cargan de forma diferida y existen presupuestos gzip por chunk y por aplicación. Falta medir LCP, INP y CLS antes/después en producción con tráfico o sesiones representativas.
- [x] **Dependencias compatibles actualizadas.** El lockfile usa las versiones actuales compatibles con Node 24. Permanecen intencionalmente `@types/node` 24 (runtime Node 24) y TypeScript 6 (TypeScript 7 excede actualmente el peer soportado por `typescript-eslint`); se revisarán como migraciones separadas.
- [ ] **Gate de mainnet.** Siguen siendo obligatorios: cero `TODO_DEPLOY`, claves/roles segregados, KMS/MPC o arquitectura equivalente, direcciones verificadas, fork tests con RPC reales, simulacro de rollback y revisión externa independiente. No hay autorización para desplegar contratos ni promover configuración mainnet.

## Evidencia mínima para cerrar producción

1. Commit y push revisados; CI y security workflows verdes en GitHub.
2. Backup D1 cifrado y restore drill verificado antes de aplicar migraciones.
3. Migraciones `0030`–`0032` aplicadas en orden y health operativo sin dead letters.
4. Deploy del Worker y frontend autorizado, seguido de smoke autenticado en navegador real.
5. Validación de OTP recibido por email, Firebase Custom Token, perfil, red, passkeys, pagos y webhooks en el entorno desplegado.
6. Evidencia de CSP/caché/PWA y Core Web Vitals desde los dominios reales.

## Regla de actualización

Cada tarea cerrada debe registrar fecha, evidencia y entorno. Si un audit descubre trabajo adicional, se añade aquí; no se crea otro backlog paralelo ni se confunde una prueba local con validación de producción.
