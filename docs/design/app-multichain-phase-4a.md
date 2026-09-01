# Fase 4A — App multichain explícita

**Fecha:** 31 de agosto de 2026
**Estado:** candidato local implementado; migración, contratos Fuji y despliegue
remoto pendientes
**Alcance:** App personal (`client/` + `server/`). No modifica Payments,
Dashboard ni el checkout B2B.

## Decisión de producto

La App presenta activos primero, pero nunca inventa un saldo universal. Cada
saldo, dirección, operación y comprobante conserva su red real:

- Arbitrum Sepolia continúa como red hogar.
- Avalanche Fuji aparece como cuenta satélite y soporta AVAX nativo y USDC.
- Home puede agrupar la navegación por activo, pero muestra red y balance de la
  fila seleccionada.
- Recibir permite elegir una cuenta activa y genera el QR de esa dirección.
- Enviar, escanear, historial y comprobantes conservan `chainKey`/`chainId`.
- Una red desconocida conserva su `chainId` y no obtiene un link de explorador;
  nunca se etiqueta silenciosamente como Arbitrum.
- Swap y Earn siguen siendo capacidades de Arbitrum; abrirlos desde Fuji falla
  cerrado con una explicación y nunca ejecuta silenciosamente en otra red.

## Modelo técnico

Una identidad Firebase puede controlar varias smart accounts, una por red:

```text
Firebase UID
  ├─ Arbitrum Sepolia account (home)
  │    ├─ ETH
  │    └─ USDC
  └─ Avalanche Fuji account (satellite)
       ├─ AVAX
       └─ USDC
```

`0038_app_multichain_accounts.sql` agrega:

- `account_security_versions`: versión deseada del conjunto de passkeys.
- `user_chain_accounts`: dirección, estado y versión de seguridad por chain.
- `chain_id`/`chain_key` en operaciones y pagos pendientes.
- outbox de registro del indexer para cuentas satélite.
- índices y triggers que marcan una satélite `needs_sync` ante cualquier cambio
  de passkeys.

La cuenta hogar existente se migra a `user_chain_accounts`; no se recalcula ni
se reemplaza su dirección. Una satélite se predice y despliega con la factory de
su propia red. Por eso no se presupone que la dirección sea idéntica entre
cadenas.

## Invariantes de seguridad

1. `APP_ENABLED_CHAIN_KEYS` sólo controla qué redes describe la API/UI.
2. `APP_WALLET_RAIL_CHAIN_KEYS` autoriza preparación y envío monetario; es un
   kill switch independiente y actualmente contiene sólo Arbitrum.
3. Activar una satélite verifica en RPC bytecode de factory, verifier y
   paymaster antes de preparar el despliegue.
4. Una satélite no envía si `security_version_applied` difiere de
   `desired_version` o su estado no es `current`.
5. Agregar, retirar o recuperar una passkey avanza la versión global y obliga a
   sincronizar todas las satélites activas.
6. Recovery sólo termina cuando cada cuenta activa demostró on-chain el nuevo
   conjunto de firmantes.
7. Toda consulta de receipt, balance, indexación o reconciliación usa bindings
   request-scoped de la chain de la fila; no conserva clientes ni Promises RPC
   globales entre requests.
8. Home sirve snapshots D1. Abrir la pantalla no inicia polling RPC; el indexer,
   webhooks y jobs actualizan balances fuera del request interactivo.
9. Una red solicitada explícitamente que no está lista no cae silenciosamente a
   Arbitrum.
10. Refrescos simultáneos de redes distintas son independientes; sólo se
    deduplican solicitudes repetidas para la misma red.

## Configuración

```text
CHAIN_KEY=arbitrum-sepolia
APP_ENABLED_CHAIN_KEYS=arbitrum-sepolia,avalanche-fuji
APP_WALLET_RAIL_CHAIN_KEYS=arbitrum-sepolia,avalanche-fuji
APP_CHAIN_RPC_URLS={"43113":{"read":"...","write":"...","indexer":"..."}}
```

`APP_CHAIN_RPC_URLS` admite un string de URLs separadas por coma o roles
`read`, `write`, `indexer`, `archive` y `bundler`. Si una URL contiene una API
key se carga como Worker Secret. El validador rechaza chains desconocidas,
rails fuera de la lista visible, RPC ausente y bundler ausente cuando
`RELAYER_MODE=bundler`.

## Estado de Avalanche Fuji

La infraestructura de cuenta de la Fase 4A se desplegó en Fuji el 31 de agosto
de 2026 desde el commit `4161cd66001874dea44c9fa8c323dd6bd1907031`.
Los cinco contratos tienen bytecode y verificación `exact_match` en Sourcify:

| Componente | Dirección desplegada |
|---|---|
| Verifier | `0x121D4eca96a0CCA57bDc0A9556508A1728CF21b9` |
| Implementation | `0x249f65e909D056D314BD083400a25C563B625c1f` |
| Factory | `0x7a47D256cA1b52C9C699d3b7eF2Ed7DFd0006313` |
| Paymaster | `0x5e10256DA2DFA684846D2E695aC32e77C7885535` |
| Crosschain router | `0x64424C87E70F3973AAcA3F3Ab40593B994A52d06` |

Los manifests reproducibles están en
`contracts/deployments/43113/account-stack-v2.json` y
`contracts/deployments/43113/crosschain-router.json`. Factory, implementation,
EntryPoint v0.9, owner, firmante y tesorería coinciden con la configuración; el
paymaster tiene `0.05 AVAX` de depósito, `0.001 AVAX` de stake con espera de 24
horas y un tope de `0.01 AVAX` por operación patrocinada.

El rail Fuji se abre sólo en testnet para ejecutar el cierre real de la Fase 4A.
Contratos, RPCs independientes y App Worker/Web ya pasaron sus gates. La fase
no se declara completa hasta probar una cuenta satélite con passkey real, una
operación patrocinada y un envío AVAX/USDC con evidencia de recibo. Si falla
uno de esos gates, el rollback es retirar `avalanche-fuji` del kill switch y
redesplegar App Worker; la lectura del portfolio permanece disponible.

## Evidencia local del candidato

El 31 de agosto de 2026 `pnpm verify:all` terminó con exit `0`:

- App Worker: 287 unitarias y 29 pruebas bajo workerd.
- Payments Worker, para confirmar que la separación no sufrió regresiones: 52
  unitarias y 23 bajo workerd.
- Navegador: 84 aprobadas y 64 omisiones deliberadas por superficie/proyecto;
  incluye Home con AVAX/Fuji, navegación assets-first y Earn fail-closed.
- Chromium real, viewport móvil `390x844`: Recibir cambió de Arbitrum/USDC a
  Avalanche Fuji/AVAX, mostró la dirección satélite y la advertencia correctas,
  y ocultó el rail avanzado que no aplica a AVAX.
- Una `sourceChainKey` desconocida dejó Crosschain deshabilitado sin consultar
  configuración ni balance de Arbitrum; un comprobante con red desconocida
  mostró el estado de red no identificada y no creó un enlace de explorer.
- D1: restore drill de 64 tablas con integridad y foreign keys, incluida `0038`.
- Contratos: 193 aprobadas, 0 fallidas y 4 forks omitidos por no tener RPC local;
  storage layout, cobertura, tamaños y lint también pasan.
- Dependencias de producción: 0 vulnerabilidades conocidas; bundles dentro de
  presupuesto, 14 diagramas reproducibles y `git diff --check` limpio.

Esta evidencia demuestra el candidato local. No demuestra bytecode Fuji, una
cuenta satélite real, una ceremonia passkey en dispositivo ni un movimiento
AVAX/USDC remoto.

## Orden de promoción

1. Congelar y versionar un commit reproducible.
2. Ejecutar la matriz local completa y el restore drill de D1.
3. Desplegar y verificar la infraestructura Fuji, sin habilitar el rail.
4. Crear backup cifrado de App D1 y aplicar únicamente las migraciones App
   pendientes, incluida `0038`.
5. Desplegar App Worker con Fuji visible pero el rail cerrado.
6. Desplegar App Web y comprobar Home, Recibir, historial y fail-closed.
7. Agregar `avalanche-fuji` al kill switch de testnet y ejecutar activación,
   firma, envío AVAX/USDC, cambio de passkey, sync y recovery con evidencia
   real. Revertir el kill switch inmediatamente si algún gate falla.
8. Declarar la fase completa sólo con recibos y estados D1/on-chain
   reconciliados.

Ningún paso de este documento autoriza una mutación remota por sí mismo.
