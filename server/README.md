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

`/user/transactions` reconstruye el historial combinando:

- En Base Sepolia usa Blockscout.
- En Monad testnet usa el `RPC_URL` directamente para leer transferencias ERC-20 visibles en logs recientes.
- D1 sigue aportando los pagos y links que pasan por la app para no depender de un indexador pago.

Esto evita depender de BlockVision o de planes pagos para el historial de Monad.
Como tradeoff, el historial externo de Monad queda acotado a una ventana reciente cuando usas un RPC free como Alchemy.

## D1

### Aplicar migraciones

```txt
npx wrangler d1 migrations apply parmeliadb --local
npx wrangler d1 migrations apply parmeliadb --remote
```

## Secrets y variables

- Usa `vars` para configuracion no sensible como:
  - `FIREBASE_PROJECT_ID`
  - `CHAIN_KEY`
- Usa `wrangler secret put` o `.dev.vars` para:
  - `RPC_URL`
  - `PRIVATE_KEY`
  - `PAYMASTER_SIGNER_PRIVATE_KEY` si separas la firma del paymaster

### Configurar secrets remotos

```txt
npx wrangler secret put RPC_URL
npx wrangler secret put PRIVATE_KEY
```

### Desarrollo local

Crea `server/.dev.vars` basado en `server/.dev.vars.example`.
