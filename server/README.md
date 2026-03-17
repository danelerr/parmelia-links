# Server (Cloudflare Worker)

## Desarrollo local

```txt
npm install
npm run dev
```

## Despliegue

```txt
npm run deploy
```

## Generar tipos del Worker

```txt
npm run cf-typegen
```

## Storage actual

### D1: fuente principal de datos de aplicacion

Se usa para:

- usuarios y usernames,
- wallet address del usuario,
- `credentialId` mas reciente,
- estado del faucet,
- links de cobro,
- operaciones pendientes entre `prepare` y `submit`,
- auditoria app-level de transacciones enviadas.

### Blockchain: fuente principal de verdad para historial

`/user/transactions` reconstruye el historial primero desde la actividad on-chain indexada por Blockscout:

- `token-transfers` para ERC-20,
- `transactions` para transferencias directas,
- `internal-transactions` para movimientos internos relevantes en smart accounts.

D1 solo se usa para enriquecer metadata de la app o como fallback si el indexador falla.

### KV: solo migracion temporal

`PARMELIA_KV` ya no participa en las rutas normales de negocio.

Solo queda para una migracion puntual de datos viejos a D1. Despues de migrar y purgar, puedes quitar el binding de KV del worker.

## D1

### Aplicar migraciones

```txt
npx wrangler d1 migrations apply parmeliadb --local
npx wrangler d1 migrations apply parmeliadb --remote
```

## Migrar datos viejos de KV a D1

Configura un secret temporal:

```txt
npx wrangler secret put STORAGE_MIGRATION_TOKEN
```

Luego despliega y ejecuta:

```txt
POST /internal/storage/migrate-kv-to-d1
x-storage-migration-token: <tu token>
Content-Type: application/json

{
  "dryRun": true,
  "purgeKv": false
}
```

Si el resultado se ve bien, repite con:

```json
{
  "dryRun": false,
  "purgeKv": true
}
```

Despues de eso:

1. quita `PARMELIA_KV` de `wrangler.jsonc`,
2. elimina `STORAGE_MIGRATION_TOKEN`,
3. vuelve a desplegar.

## Secrets y variables

- Usa `vars` solo para configuracion no sensible como `FIREBASE_PROJECT_ID`.
- Usa `wrangler secret put` o `.dev.vars` para:
  - `RPC_URL`
  - `PRIVATE_KEY`
  - `STORAGE_MIGRATION_TOKEN` temporal

### Configurar secrets remotos

```txt
npx wrangler secret put RPC_URL
npx wrangler secret put PRIVATE_KEY
```

### Desarrollo local

Crea `server/.dev.vars` basado en `server/.dev.vars.example`.
