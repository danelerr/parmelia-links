# Runbook: reemplazo semántico del corte Payments

**Estado:** ejecutado remotamente el 26-08-2026; conservado como procedimiento reproducible
**Motivo:** el target del 25-08-2026 conserva un checksum histórico basado en
IDs. Ese valor no demuestra el contenido de las filas y no puede convertirse en
evidencia semántica mediante un `UPDATE` del control.

## Decisión

No se reetiqueta la D1 actual. Se hace un corte nuevo hacia una D1 vacía y se
conserva la anterior para rollback y auditoría. Esta es la única ruta aprobada
mientras `PAYMENT_LIVE_ENABLED=false` y el delta posterior quede clasificado.

La ejecución del 26-08-2026 creó
`gatopago-payments-semantic-20260826`, aplicó `0001`–`0006` y fijó el checksum
semántico
`5d3093e9b12288d7783832037b3bf06635591da1cf56df377ff4b4b6f3093a27`.
La D1 histórica `gatopago-payments` se conservó intacta. El detalle auditable
está en el [registro de cierre](../operations/phase-2-1-live-readiness-2026-08-26.md).

El delta observado durante la ejecución fue: el target histórico creció de 4 a 7 merchants por el
sync de cuentas y recibió al menos una quote de test. Los merchants derivados se
recrean drenando nuevamente el sync después del nuevo import; no se copian a
mano. La quote debe clasificarse explícitamente como artefacto test descartable o
como registro que se conserva sólo en la D1 histórica. Esa decisión se registra
antes de continuar. Si aparece cualquier attempt, pago, API key, webhook o evento
exclusivo que no sea descartable, detener este procedimiento: hace falta una
reconciliación hacia delante, fila por fila; no se debe sobrescribir ni fusionar
automáticamente ninguna D1.

## Evidencia obligatoria

Antes de abrir la ventana, versionar y publicar exactamente el árbol que se va a
desplegar. Los comandos `pnpm --filter ... run deploy` deben rechazar cualquier
fuente dirty, sin upstream o distinta del commit remoto.

Conservar fuera del workspace:

- backup cifrado de App D1 y de la Payments D1 histórica;
- versiones desplegadas de App y Payments;
- export App capturado después del freeze y drain;
- `split-manifest.json` versión 4;
- hash del artefacto data-only;
- export del nuevo target después del import;
- salida de la verificación semántica, `quick_check` y `foreign_key_check`;
- UUID y nombre de ambas D1 Payments.

El manifest v4 calcula un checksum semántico por tabla, columnas y contenido.
Para webhooks descifra sólo en memoria y hashea el plaintext dentro del checksum
global; normaliza `secret_ciphertext`/`secret_key_id` porque AES-GCM usa nonces
aleatorios. El plaintext y las claves nunca se escriben en el manifest ni se
imprimen.

## Secuencia fail-closed

### 1. Congelar y drenar

1. Mantener `PAYMENT_LIVE_ENABLED=false`.
2. Versionar `PAYMENTS_CUTOVER_MODE=frozen` y
   `PAYMENTS_SYNC_ENABLED=false`.
3. Desplegar App exclusivamente mediante:

   ```powershell
   pnpm --filter server run deploy
   ```

4. Probar que las escrituras de checkout devuelven `503`, pero las lecturas y
   superficies personales continúan disponibles.
5. Drenar jobs/outboxes y resolver toda dead letter. Capturar el watermark.
6. Consultar la D1 Payments histórica y clasificar todo delta respecto al
   snapshot original. Cero attempts/pagos live y una decisión escrita sobre los
artefactos test son precondiciones. En el corte ejecutado se clasificaron tres
merchants derivados por sync y una quote local expirada sin attempt/pago; todos
permanecieron sólo en el target histórico.
7. Ejecutar backups cifrados y registrar versiones antes de modificar schema o
   bindings.

   ```powershell
   node scripts/d1-backup.mjs --remote --output <DIRECTORIO_PROTEGIDO>\app.sql.enc
   node scripts/d1-backup.mjs --remote-payments --output <DIRECTORIO_PROTEGIDO>\payments-historical.sql.enc
   ```

   Ambos comandos usan la misma clave de archivo inyectada sólo al proceso; el
   segundo cambia explícitamente al binding `PAYMENTS_DB` y valida tablas del
   dominio Payments antes de aceptar el backup.

### 2. Construir el artefacto desde App congelada

Exportar App de forma read-only:

```powershell
pnpm --filter server exec wrangler d1 export GATOPAGO_DB --remote `
  --output <DIRECTORIO_PROTEGIDO>\app-frozen.sql -y
```

Construir el target local y la evidencia usando la clave Payments existente
protegida por DPAPI; el wrapper no rota ni imprime la clave:

```powershell
.\scripts\prepare-payments-semantic-split.ps1 `
  -SourceSql <DIRECTORIO_PROTEGIDO>\app-frozen.sql `
  -TargetSqlite <DIRECTORIO_PROTEGIDO>\payments-candidate.sqlite `
  -EvidenceDirectory <DIRECTORIO_PROTEGIDO>\semantic-split
```

El comando debe demostrar checksum v2, tamper negativo, import único, FK,
`quick_check`, restores independientes y cifrado webhook compatible con el
runtime `enc:v2`.

### 3. Crear un target nuevo

Crear otra D1, nunca vaciar/reutilizar la histórica:

```powershell
pnpm --filter payments-worker exec wrangler d1 create <NEW_PAYMENTS_DB>
pnpm --filter payments-worker exec wrangler d1 migrations apply <NEW_PAYMENTS_DB> --remote
pnpm --filter payments-worker exec wrangler d1 migrations list <NEW_PAYMENTS_DB> --remote
```

La lista debe incluir todas las migraciones descubiertas, incluida
`0006_checkout_attempt_access.sql`. Verificar que las tablas de negocio están
vacías y `payment_migration_control` está pristine.

Importar una sola vez mientras App sigue congelada y Payments continúa en
bootstrap/live disabled:

```powershell
pnpm --filter payments-worker exec wrangler d1 execute <NEW_PAYMENTS_DB> --remote `
  --file <DIRECTORIO_PROTEGIDO>\semantic-split\gatopago-payments-data.sql -y
```

Una importación parcial o repetida obliga a abandonar esa D1 y crear otra. No se
repara con deletes ni updates manuales.

### 4. Verificar el target importado

Exportar el target nuevo y verificarlo contra el manifest v4 antes de aceptar
una sola escritura:

```powershell
pnpm --filter payments-worker exec wrangler d1 export <NEW_PAYMENTS_DB> --remote `
  --output <DIRECTORIO_PROTEGIDO>\payments-imported.sql -y

# La clave se inyecta al proceso desde DPAPI; no aparece en stdout.
.\scripts\invoke-phase2-preflight.ps1
```

Antes de ese último preflight, el UUID de `PAYMENTS_DB`, el checksum semántico
del manifest y los estados `frozen/bootstrap` deben estar versionados. El
preflight exporta nuevamente el binding `PAYMENTS_DB` y ejecuta
`--verify-target-sql`; no acepta sólo IDs, conteos o el valor declarado en
`payment_migration_control`.

### 5. Promover sin abrir pagos live

1. Desplegar Payments primero mediante
   `pnpm --filter payments-worker run deploy`.
2. Exigir checksum configurado = control D1 = snapshot semántico y export target
   verificado.
3. Desactivar bootstrap; mantener App congelada y `PAYMENT_LIVE_ENABLED=false`.
4. Habilitar/drenar sync, cambiar App a `payments` y desplegar App mediante el
   entrypoint protegido.
   Si un intento anterior ya consumió el outbox sembrado por `0033`, volver a
   sembrar idempotentemente desde las cuentas wallet existentes usando la misma
   clave lógica de deduplicación de la migración; después exigir outbox vacío y
   paridad de merchants. No insertar merchants manualmente en Payments.
5. Desplegar cliente/dashboard sólo después de los preflights remotos.
6. Ejecutar smokes anónimos y autenticados. No activar pagos live durante este
   corte.

## Prohibiciones

- No ejecutar `UPDATE payment_migration_control ...` para convertir el checksum
  histórico en uno semántico.
- No importar sobre una D1 con filas de negocio.
- No usar `wrangler deploy` directamente; siempre usar el script `run deploy`.
- No copiar claves a argumentos, archivos del repositorio, logs o manifests.
- No borrar la D1 histórica ni los backups durante el soak.
