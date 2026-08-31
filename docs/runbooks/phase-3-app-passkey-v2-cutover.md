# Runbook de promoción — Fase 3 App Passkey Security v2.1

**Alcance:** App de consumo, App Worker y App D1.

**Contrato WebAuthn vigente:** RP ID `app.parmelia.me`, origen
`https://app.parmelia.me`.

**Corte v2 ejecutado el 30-08-2026:** `0035` y `0036` están aplicadas; App Worker
`a2ea1d70-0553-48fd-8501-201bfe7e5143` y App Web
`parmelia-hgcd1c3es-danelerrs-projects.vercel.app` publican Passkey Security v2.
El preflight quedó con 12 checks listos. `PAYMENT_LIVE_ENABLED=false` permanece
fuera de alcance.

**Corte v2.1 autorizado el 30-08-2026:** aplica únicamente
`0037_webauthn_authentication.sql` y publica App Worker/App Web. Corrige la
disponibilidad real de passkeys, el retiro compatible, los duplicados del
gestor y el ingreso seguro a recuperación. Este documento conserva al final la
evidencia y los identificadores del corte.

El bundle candidato selecciona `browserLocalPersistence` y el resolver de
redirect dentro de `initializeAuth`; no cambia persistencia después de iniciar
Firebase. `check:frontend-deploy-config` hace fallar la promoción si reaparece
esa carrera de inicialización.

Este procedimiento promueve el modelo de seguridad de llaves sin cambiar
Firebase Auth, proveedor de hosting, contratos, Payments o política monetaria.

## Límite de autorización

Cada mutación necesita autorización explícita y vigente para su acto concreto:

1. versionar y publicar el árbol exacto;
2. crear un backup cifrado de App D1 fuera del workspace;
3. aplicar únicamente `0037_webauthn_authentication.sql` en `GATOPAGO_DB`;
4. desplegar únicamente App Worker (`server`) y App Web (`client`);
5. crear, renombrar, revocar o probar una llave mediante una operación real.

Los primeros cuatro puntos no autorizan el quinto. Registrar o revocar un signer
puede producir una operación on-chain aunque no sea un pago. No se autoriza
Payments Worker/D1, Dashboard, contratos, DNS, secrets, buzones, fees, mainnet ni
movimientos monetarios. No reutilizar la autorización histórica de `0035`.

La excepción histórica de backup manual registrada para el corte `0036` no se
reutiliza. El corte `0037` exige backup cifrado y verificado antes de migrar.

## 1. Preflight local y remoto de solo lectura

Desde la raíz del repositorio:

```powershell
git status --short
git diff --check
pnpm verify:all
pnpm check:app-deploy-guard
pnpm check:phase3-app-preflight
pnpm check:deploy-source-guard
pnpm preflight:phase3-app:remote --json
pwsh -NoProfile -File scripts/deploy-phase3-app-web.ps1 -PlanOnly
```

Antes del corte, los únicos pendientes remotos admisibles son:

- `published-source` mientras el candidato no esté publicado;
- `app-migration-0037`;
- `app-passkey-schema-0037` mientras `0037` no haya creado la tabla de
  challenges, el contador y sus índices;
- `app-webauthn-bindings` mientras siga activa la versión anterior;
- checks de App Web que dependan del nuevo bundle, si los hubiera.

`app-migration-0035`, `app-migration-0036`, secrets por nombre, health, App pública, Firebase, CSP y
ruta Email Link deben estar listos. El preflight inspecciona **todas** las
versiones con tráfico y compara los bindings públicos sin leer valores de
secrets.

Confirmar el inventario exacto:

```powershell
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler deployments status --name server --json
node scripts/assert-app-remote-migrations.mjs
```

Antes de aplicar la migración, el último comando debe fallar indicando solamente
`0037_webauthn_authentication.sql`. Detenerse si falta otra migración, existe
una pendiente adicional o no puede leerse D1.

## 2. Congelar una fuente reproducible

Revisar el diff completo y los archivos nuevos. Sólo con autorización de
commit/push, publicar un commit cuya CI/security esté verde. Después:

```powershell
git status --short
git rev-parse HEAD
git rev-parse '@{upstream}'
node scripts/assert-reproducible-deploy-source.mjs server client
```

El árbol relevante debe estar limpio y `HEAD` debe coincidir con su upstream.
Los entrypoints de Worker y Vercel rechazan una fuente dirty o no publicada.

## 3. Capturar rollback y respaldar App D1

Guardar fuera del repositorio los identificadores de las versiones vigentes:

```powershell
pnpm --filter server exec wrangler deployments status --name server --json

$vercelCli = Join-Path $env:APPDATA 'npm\node_modules\vercel\dist\vc.js'
node $vercelCli inspect app.parmelia.me --json --scope danelerrs-projects --no-color
```

Cargar una clave de backup existente o expresamente aprobada sólo en el proceso
actual. La ruta debe estar protegida y fuera del workspace:

```powershell
$env:D1_BACKUP_ENCRYPTION_KEY = '<CARGAR_DESDE_GESTOR_SEGURO>'
$env:D1_BACKUP_ENCRYPTION_KEY_ID = '<ID_DE_CLAVE_EXISTENTE>'
$backupPath = '<RUTA_PROTEGIDA_FUERA_DEL_WORKSPACE>\app-pre-0037.sql.enc'

node scripts/d1-backup.mjs --remote --output $backupPath
node scripts/d1-backup.mjs --verify $backupPath
```

No continuar sin export cifrado, `quick_check=ok`, claves foráneas válidas y
restore drill verde. Luego retirar las variables del proceso:

```powershell
Remove-Item Env:D1_BACKUP_ENCRYPTION_KEY -ErrorAction SilentlyContinue
Remove-Item Env:D1_BACKUP_ENCRYPTION_KEY_ID -ErrorAction SilentlyContinue
```

## 4. Aplicar exclusivamente `0037`

Volver a listar. La tabla debe mostrar una única fila:

```text
0037_webauthn_authentication.sql
```

Sólo entonces:

```powershell
pnpm --filter server exec wrangler d1 migrations apply GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 execute GATOPAGO_DB --remote --command "SELECT name FROM d1_migrations WHERE name = '0037_webauthn_authentication.sql';"
node scripts/assert-app-remote-migrations.mjs
```

La lista de pendientes debe quedar vacía, el `SELECT` debe devolver `0037` y el
guard debe comprobar la tabla/challenges, `passkeys.sign_count`, su restricción
no negativa y los dos índices de autenticación. No ejecutar SQL manual ni
migraciones Payments.

## 5. Desplegar sólo App Worker y App Web

Primero el Worker mediante su único entrypoint guardado:

```powershell
$releaseSha = git rev-parse HEAD
pnpm --filter server run deploy --dry-run
pnpm --filter server run deploy --keep-vars --strict --message "phase3 passkey-v2.1 $releaseSha"
```

La cadena de deploy exige fuente publicada, configuración WebAuthn estable,
cero migraciones App pendientes y el inventario remoto de secrets. No crea ni
rota secrets. `--keep-vars` conserva configuración remota ajena y Wrangler
publica las variables no sensibles declaradas en `server/wrangler.jsonc`.
Los flags se pasan directamente después de `run deploy`; un separador `--`
adicional está prohibido porque puede neutralizar `--dry-run`.

Después, únicamente si cambió `client/`:

```powershell
pwsh -NoProfile -File scripts/deploy-phase3-app-web.ps1
```

El script no puede tocar Dashboard, Payments, proyectos, aliases ni variables
Vercel fuera de la App revisada.

## 6. Verificación remota sin mutaciones sensibles

```powershell
pnpm preflight:phase3-app:remote --json
```

Todos los checks deben quedar `ready`. En particular:

- `app-migration-0035`, `app-migration-0036` y `app-migration-0037`;
- `app-passkey-schema-0037`;
- `app-webauthn-bindings` en cada versión con tráfico;
- health, App pública, CSP, Email Link, Vercel y Firebase.

En una sesión existente, sin crear o borrar signers:

1. abrir `Configuración → Seguridad` y confirmar que no hay recovery automático;
2. comprobar que la lista distingue llaves sincronizables, de dispositivo,
   físicas o desconocidas sin afirmar más de lo que indica la metadata;
3. abrir “Más información” y confirmar RP, proveedor estimado y estado de backup;
4. iniciar un flujo que requiera llave y comprobar que, si falta, dirige a
   Seguridad con un retorno same-origin; una URL externa debe ser rechazada;
5. comprobar Google/Email Link, service worker, health y consola sin regresiones.

## 7. Ceremonias reales bajo autorización separada

No registrar identificadores completos de credenciales, challenges, respuestas
WebAuthn, tokens, UID o datos biométricos. La biometría nunca sale del
autenticador.

Con autorización separada para mutaciones de seguridad:

1. verificar una passkey existente en `app.parmelia.me` antes de crear otra;
2. añadir una passkey integrada y confirmar que la metadata no confunde
   “sincronizable” con “sincronizada”;
3. si hay hardware disponible, desplegar la opción progresiva y añadir una llave
   física; no convertirla en requisito general;
4. renombrar una llave y comprobar persistencia;
5. intentar eliminar la última llave y confirmar bloqueo;
6. con más de una llave/signers válidos, revocar sólo la elegida y verificar que
   D1 y el inventario on-chain siguen coincidiendo;
7. confirmar que Signal API sólo se ejecuta con inventario exacto y nunca decide
   la autorización financiera.

Detenerse antes de pagos, swaps, cross-chain o recovery on-chain no autorizados.

## 8. Rollback

Si falla el Worker, restaurar la versión capturada:

```powershell
pnpm --filter server exec wrangler rollback <VERSION_ID_ANTERIOR> --message "rollback phase3 passkey-v2" --yes
```

Si falla la App Web:

```powershell
$vercelCli = Join-Path $env:APPDATA 'npm\node_modules\vercel\dist\vc.js'
node $vercelCli rollback <DEPLOYMENT_ANTERIOR> --yes --scope danelerrs-projects --no-color
```

`0037` es aditiva y no se revierte a ciegas; el código anterior puede convivir
con sus columnas. Ante daño de datos se detienen escrituras y se activa el
procedimiento de incidente con Time Travel o backup cifrado.

No cambiar `PASSKEY_RP_ID` como rollback. Un RP distinto hace que las credenciales
existentes dejen de ser utilizables y requiere un plan de coexistencia propio.

## Criterio de cierre

Passkey Security v2 sólo queda promovido cuando existe evidencia de:

- commit publicado y CI/security verdes;
- backup cifrado y restore drill;
- `0037` aplicada y cero migraciones App pendientes;
- versiones Worker/Web y rollback identificados;
- preflight remoto completamente verde, incluidos ambos bindings WebAuthn;
- UX de Seguridad y retorno same-origin verificados en producción;
- ceremonia real autorizada con una llave existente y, cuando sea posible,
  passkey nueva/llave física;
- health estable sin dead letters nuevas.

Esto no activa pagos ni reemplaza los E2E monetarios y fault injection de Fase 4.
La promoción técnica fue versionada y validada; la ceremonia WebAuthn real sigue
requiriendo la sesión, el autenticador y el gesto del usuario.
