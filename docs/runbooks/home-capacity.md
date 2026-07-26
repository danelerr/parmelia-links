# Capacity test de Home

El objetivo de este test no es generar actividad on-chain. Debe demostrar que
abrir Home aumenta tráfico HTTP/D1, pero mantiene:

```text
RPC/CU atribuible a home_view = 0
```

El script `scripts/load-home.mjs` es local por defecto, limita solicitudes y
concurrencia, no acepta tokens en argumentos y exige `--allow-remote` para
staging. No ejecutarlo contra producción sin una ventana de carga aprobada.

## Preparación

1. Aplicar todas las migraciones en una D1 de staging.
2. Sembrar identidades con snapshots completos de ETH, USDC y aUSDC.
3. Guardar uno o más Firebase ID tokens de staging en un archivo fuera del
   repositorio: un token por línea o un array JSON de strings.
4. Verificar `/health` y dejar abiertos los logs/métricas del Worker, D1 y RPC.

Un token mide el caso más caliente: muchas pestañas del mismo usuario. Varios
tokens se distribuyen round-robin y miden identidades distintas. El script
calienta cada identidad, conserva su ETag y luego mide respuestas `304`/`200`.

## Ejecución local

```powershell
pnpm dev:server
pnpm load:home -- --token-file C:\secure\parmelia-staging-tokens.txt `
  --requests 1000 --concurrency 100 --assert-p95 200
```

## Ejecución en staging

```powershell
pnpm load:home -- `
  --url https://<worker-staging>/home `
  --allow-remote `
  --token-file C:\secure\parmelia-staging-tokens.txt `
  --requests 10000 `
  --concurrency 250 `
  --assert-p95 200
```

Nunca guardar ni pegar los tokens en logs, shell history, CI artifacts o el
repositorio.

## Criterios de aceptación

- Cero errores de red y cero respuestas `5xx`.
- p95 menor o igual al SLO elegido; el valor inicial es 200 ms.
- Alta proporción de `304` después del warm-up cuando el modelo no cambia.
- Cero llamadas RPC cuyo origen sea `home_view`.
- La cantidad de llamadas RPC/indexer no cambia al repetir la prueba con 1, 100
  o 1.000 identidades sin actividad on-chain.
- Ningún `balance_refresh_request` nuevo por mera antigüedad; sólo se permite
  bootstrap de assets ausentes.
- D1 y Worker conservan headroom y no aparecen colas muertas.

El guard estático complementario se ejecuta con:

```powershell
pnpm check:home-no-rpc
```

Ese guard evita imports o llamadas RPC directas desde la ruta/read model. La
prueba de carga confirma el comportamiento del artefacto desplegado.

## Dos ejes separados

No mezclar estas mediciones:

1. **Vistas:** aumentar usuarios/concurrencia sin producir transacciones.
2. **Cadena:** aumentar eventos por bloque con una cantidad fija de vistas.

Si las vistas aumentan RPC/CU, existe una regresión del read path. Si los eventos
aumentan RPC/CU, es carga legítima del ingestor y debe evaluarse por llamada,
logs devueltos, lag y costo.
