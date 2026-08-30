# Runbook de corte — Fase 3 App con Firebase Magic Link

> **Registro histórico ejecutado para `0035`.** No reutilizar este procedimiento
> ni su autorización para el candidato Passkey Security v2. La promoción vigente
> de `0036`, RP ID y UX de llaves está en
> [phase-3-app-passkey-v2-cutover.md](./phase-3-app-passkey-v2-cutover.md).

**Alcance:** App de consumo, App Worker y App D1.

**Dominio vigente:** `https://app.parmelia.me`.

**Estado inicial esperado:** candidato local verificado, `0035` pendiente y
`PAYMENT_LIVE_ENABLED=false`.

Este procedimiento publica Google + Email Link nativo de Firebase para la App.
No configura un proveedor de correo: Firebase entrega el enlace.

## Límite de autorización

Antes de ejecutar cualquier paso mutante debe existir autorización explícita
para **cada** uno de estos actos:

1. versionar y publicar el árbol actual;
2. crear un backup cifrado de App D1 fuera del workspace;
3. aplicar únicamente `0035_firebase_email_links.sql` en `GATOPAGO_DB`;
4. desplegar únicamente App Worker (`server`) y App Web (`client`);
5. solicitar y consumir un magic link real en un buzón expresamente autorizado.

La autorización no incluye Payments Worker, Payments D1, Dashboard, contratos,
DNS, creación o rotación de secrets, `PAYMENT_LIVE_ENABLED`, mainnet ni
operaciones monetarias/on-chain. No reutilizar una autorización anterior para
Resend: ese proveedor ya no forma parte de la arquitectura.

## 1. Precondiciones locales y remotas

Desde la raíz:

```powershell
git status --short
git diff --check
pnpm verify:all
pnpm preflight:phase3-app:remote --json
pwsh -NoProfile -File scripts/deploy-phase3-app-web.ps1 -PlanOnly
```

Antes de publicar, el preflight remoto puede mostrar como pendientes solamente:

- `published-source`;
- `app-migration-0035`;
- `deployed-email-link-route`;
- `app-google-auth-csp`, únicamente mientras App Web siga sirviendo la CSP
  anterior que bloquea `apis.google.com`.

Debe mostrar listos health, acceso público, proyecto/variables Vercel, nombres
de secrets App y configuración Firebase. El preflight es read-only: la única
petición `POST` usa un email inválido que se rechaza antes de Turnstile, cuotas,
D1 o entrega. El gate `pnpm check:phase3-app-preflight` impide convertirlo en un
emisor de correo o comando de mutación.

También confirmar:

```powershell
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler versions list --name server --json
```

`0035` debe ser la única migración App pendiente. No continuar si aparecen
otras migraciones, health degradado o un pendiente remoto adicional.

## 2. Congelar la fuente exacta

Revisar todo el diff, incluidos archivos nuevos. Sólo con autorización de
commit/push, crear un commit y publicarlo en la rama con upstream. Después:

```powershell
git status --short
git rev-parse HEAD
git rev-parse '@{upstream}'
node scripts/assert-reproducible-deploy-source.mjs server client
```

El árbol relevante debe estar limpio y ambos SHA deben coincidir. Los Workers y
Vercel rechazan por diseño una fuente dirty, sin upstream o no publicada.

## 3. Capturar rollback y respaldar App D1

Guardar fuera del repositorio el resultado de estos comandos; no contiene
valores de secrets:

```powershell
pnpm --filter server exec wrangler versions list --name server --json

$vercelCli = Join-Path $env:APPDATA 'npm\node_modules\vercel\dist\vc.js'
node $vercelCli inspect app.parmelia.me --json --scope danelerrs-projects --no-color
```

El operador carga en el proceso una clave de backup existente o aprobada. No se
escribe en Git, OneDrive, documentación ni historial. La ruta final debe ser un
directorio protegido **fuera** del workspace:

```powershell
$env:D1_BACKUP_ENCRYPTION_KEY = '<CARGAR_DESDE_GESTOR_SEGURO>'
$env:D1_BACKUP_ENCRYPTION_KEY_ID = '<ID_DE_CLAVE_EXISTENTE>'
$backupPath = '<RUTA_PROTEGIDA_FUERA_DEL_WORKSPACE>\app-pre-0035.sql.enc'

node scripts/d1-backup.mjs --remote --output $backupPath
node scripts/d1-backup.mjs --verify $backupPath
```

No continuar sin export cifrado, `quick_check=ok`, claves foráneas válidas y
restore drill verde. Al terminar el corte, borrar las dos variables sólo del
proceso actual:

```powershell
Remove-Item Env:D1_BACKUP_ENCRYPTION_KEY -ErrorAction SilentlyContinue
Remove-Item Env:D1_BACKUP_ENCRYPTION_KEY_ID -ErrorAction SilentlyContinue
```

## 4. Aplicar solamente `0035`

Las migraciones se aplican antes del Worker:

```powershell
pnpm --filter server exec wrangler d1 migrations apply GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 execute GATOPAGO_DB --remote --command "SELECT name FROM d1_migrations WHERE name = '0035_firebase_email_links.sql';"
```

La salida debe contener exactamente `0035_firebase_email_links.sql`. No aplicar
migraciones Payments ni ejecutar SQL manual adicional.

## 5. Desplegar App Worker y App Web

Primero App Worker, usando su único entrypoint guardado:

```powershell
$releaseSha = git rev-parse HEAD
pnpm --filter server run deploy -- --dry-run
pnpm --filter server run deploy -- --keep-vars --strict --message "phase3 app magic links $releaseSha"
```

El deploy usa los secrets App ya existentes. No ejecuta `secret put` ni cambia
sus valores.

Después desplegar únicamente `client/`:

```powershell
pwsh -NoProfile -File scripts/deploy-phase3-app-web.ps1
```

Ese script verifica proyecto/team, captura el deployment anterior, exige fuente
publicada, despliega `parmelia` en producción y comprueba que
`app.parmelia.me` apunta a la nueva versión. No vincula proyectos, no configura
variables y no toca `dashboard/` ni Payments.

## 6. Preflight y smokes sin buzón

```powershell
pnpm preflight:phase3-app:remote --json
```

Todos sus checks deben quedar `ready`. Esto prueba infraestructura y que la ruta
desplegada falla cerrada. También comprueba en la respuesta pública que la CSP
permite el cargador y frame necesarios para Google. Todavía **no** prueba una
sesión Google completa ni recepción real de correo.

En un navegador limpio verificar:

1. `app.parmelia.me` responde sin Vercel SSO;
2. Turnstile termina o muestra timeout + retry, nunca un spinner infinito;
3. Google abre el proveedor Firebase sin error CSP;
4. no aparece input de seis dígitos, Resend ni proveedor de wallet externo;
5. health App permanece `ok` y no aparecen dead letters nuevas.

## 7. Prueba real expresamente autorizada

No escribir el buzón, link completo, `oobCode`, ID token ni challenge en Git,
capturas públicas, logs o evidencias. Registrar únicamente timestamps, estados,
UID redactado/hash y códigos de resultado.

Con el buzón autorizado:

1. solicitar un único link desde `app.parmelia.me`;
2. comprobar recepción y remitente Firebase esperado;
3. abrirlo en el mismo navegador y confirmar sesión;
4. repetir de forma controlada en otro navegador/dispositivo: la App debe pedir
   el correo y no obtenerlo desde la URL;
5. entrar por Google con la misma identidad y comprobar el mismo Firebase UID;
6. solicitar un link de recovery, reautenticar y canjear el challenge;
7. repetir el mismo canje y comprobar rechazo por replay;
8. detenerse antes de proponer una recuperación on-chain o mover fondos.

Si el correo no llega, no cambiar DNS ni crear proveedores alternativos.
Revisar primero la respuesta sanitizada de Firebase, cuotas, spam y authorized
domains; conservar el sistema fail-closed.

## 8. Rollback

Si App Worker falla, usar el ID capturado antes del corte:

```powershell
pnpm --filter server exec wrangler rollback <VERSION_ID_ANTERIOR> --message "rollback phase3 app" --yes
```

Si App Web falla, usar el deployment anterior capturado:

```powershell
$vercelCli = Join-Path $env:APPDATA 'npm\node_modules\vercel\dist\vc.js'
node $vercelCli rollback <DEPLOYMENT_ANTERIOR> --yes --scope danelerrs-projects --no-color
```

`0035` es aditiva y no se revierte a ciegas. Un rollback de código puede convivir
con ella. Ante daño de datos se detienen escrituras y se usa Time Travel o el
backup cifrado mediante un procedimiento de incidente separado.

## Criterio de cierre

Fase 3 App sólo se declara cerrada cuando estén archivadas estas evidencias:

- commit publicado y CI/security verdes;
- backup cifrado + restore drill;
- `0035` aplicada;
- App Worker y App Web identificados por versión/deployment;
- preflight remoto completamente verde;
- Google, Turnstile y magic link real verificados;
- mismo UID y replay de recovery rechazado;
- health estable y rollback identificable.

Nada de lo anterior habilita pagos reales ni cierra Fase 4.
