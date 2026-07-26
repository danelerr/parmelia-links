# Evaluación Técnica de Parmelia

> Documento de evaluación de ingeniería: stack, arquitectura, escalabilidad,
> seguridad y estrategia de plataforma (web / PWA / app nativa).
> Fecha: junio 2026. Basado en revisión del código de `client/`, `server/`,
> `contracts/` y `shared/`.
>
> **Actualización (jun-2026):** desde esta evaluación el proyecto **migró a
> Arbitrum** (ya no Monad) y se resolvieron varios puntos de abajo: el historial
> ahora se sirve desde un **ledger en D1 + cron indexer** (no se reconstruye en
> cada request - §5.2 resuelto), el login es **multi-método** (Google + enlace
> mágico; Apple se descartó), y se añadieron **Turnstile**, **push FCM** y
> **analytics**. El cuello de botella del **relayer EOA único (§5.1)** sigue
> pendiente (se resuelve al migrar a un bundler gestionado).
>
> **Nota (jul-2026):** este documento es un **snapshot histórico**. El estado
> vigente (auditoría integral, endurecimiento de backend/contratos, API `/v1` +
> dashboard, cross-chain CCTP) vive en `CODEX_REAUDITORIA_2026-07-13.md` y
> `ARCHITECTURE.md`.

---

## 1. Resumen ejecutivo

**Parmelia está construido sobre las tecnologías correctas y con decisiones de arquitectura por encima del promedio.** La combinación Account Abstraction (ERC-4337) + passkeys WebAuthn + gas patrocinado resuelve, de verdad, el mayor problema de UX de cripto: nada de seed phrases ni de pagar gas. Eso encaja muy bien con el producto que quiere ser (links de cobro / pagos cripto tipo "Stripe links" cripto-nativo).

**Pero como está hoy no es escalable a producto.** Hay un cuello de botella dominante: **el servidor actúa como relayer/bundler con un único EOA (`PRIVATE_KEY`)** que firma todas las transacciones on-chain de todos los usuarios. Eso impone un límite duro de throughput (los nonces de un EOA son secuenciales) y es un punto único de falla y de seguridad. Lo bueno: arreglarlo es un cambio acotado y bien entendido, no una reescritura.

| Dimensión | Veredicto |
| --- | --- |
| Stack tecnológico | ✅ Correcto y moderno |
| Arquitectura (diseño) | ✅ Sólida, sofisticada para su tamaño |
| Encaje producto ↔ arquitectura | ✅ Muy bueno |
| Escalabilidad **actual** | ⚠️ No (cuello de botella: relayer EOA único) |
| Escalabilidad **alcanzable** | ✅ Sí, con cambios acotados |
| Seguridad / modelo de confianza | ⚠️ Aceptable para MVP, con centralización a resolver |
| Madurez operacional (tests, observabilidad, retries) | ⚠️ Parcial |

---

## 2. ¿Qué quiere ser Parmelia?

Una app de **links de cobro y pagos cripto** donde:

- cualquiera puede crear un link/QR de cobro o un username público (`/daniel`),
- el pagador entra, autoriza con biometría y paga,
- el usuario nunca gestiona claves privadas ni paga gas,
- el saldo es en USDC (estable), no en un token volátil.

El "norte" del producto es **fricción mínima en el pago**. Toda la evaluación se ancla en eso: lo que ayuda al pago gana, lo que mete fricción al pago pierde. Este principio define también la decisión de plataforma (sección 7).

---

## 3. Evaluación del stack tecnológico

### 3.1 Frontend - ✅ correcto

React 19, Vite 7, TypeScript 5.9, Tailwind v4, SWR, react-router. Stack moderno, mantenible y con buen DX. El bundle (~712 KB / 231 KB gzip) es algo pesado por Firebase + viem; mejorable con code-splitting (`React.lazy` por ruta, importar viem selectivamente), pero no es bloqueante.

### 3.2 Backend - ✅ correcto

Hono sobre Cloudflare Workers. Excelente para una API de borde: latencia global baja, escalado horizontal automático, costo bajo. El código está modularizado (rutas + servicios + middlewares) y, tras la última limpieza, sin duplicación relevante. `viem` es la librería web3 correcta.

### 3.3 Datos - ✅ correcto

Cloudflare D1 (SQLite) para metadata de la app (perfiles, links, pending ops, historial). La migración previa de KV → D1 fue la decisión correcta: el dominio es **relacional** (usuarios ↔ links ↔ pagos) y D1 da consultas, índices y FKs que KV no puede. Schema con tablas `STRICT`, FKs e índices adecuados.

### 3.4 Contratos / Account Abstraction - ✅ correcto y sofisticado

- **ERC-4337** (EntryPoint, UserOperations, paymaster) - estándar de AA.
- **AccountWebAuthnV2**: MultiSigner (ERC-7913) + ejecución (ERC-7821) + UUPS + recovery con guardian y timelock.
- **WebAuthn/P256** vía verificador ERC-7913 stateless.
- **124 tests de Foundry** en la suite vigente, con floors de cobertura por
  contrato y storage-layout diff bloqueantes en CI.

Esto es un diseño de wallet de calidad: passkeys múltiples en la misma dirección, recuperación social con ventana de 48h, y upgradeabilidad. Para un producto de pagos sin seed phrase, es exactamente lo que se necesita.

### 3.5 Identidad - ✅ pragmático

Firebase Auth + Google login. Correcto para MVP: separa **identidad** (quién es la persona en la app) de **custodia** (la passkey firma on-chain; el server no tiene la clave). El acoplamiento a Google es una dependencia a vigilar, no un error.

### 3.6 Red - ✅ con asterisco

Arbitrum (Sepolia testnet / One producción): L2 madura, fees bajos, RIP-7212 (P256 barato) y liquidez real de USDC → alineado con pagos. La **refactorización de portabilidad** mantiene la opción abierta: cambiar de cadena es agregar una entrada de config + desplegar contratos. _(Nota: la versión original de esta evaluación apuntaba a Monad; el proyecto migró a Arbitrum.)_

### Veredicto por capa

| Capa | Tecnología | Veredicto |
| --- | --- | --- |
| Frontend | React 19 / Vite / Tailwind v4 | ✅ |
| API | Hono / Cloudflare Workers | ✅ |
| Datos | Cloudflare D1 | ✅ |
| Web3 | viem | ✅ |
| Wallet | ERC-4337 + WebAuthn + ERC-7913/7821 + UUPS | ✅ |
| Identidad | Firebase Auth (Google / Apple / enlace mágico) | ✅ (acoplamiento a vigilar) |
| Red | Arbitrum (portable) | ✅ (L2 madura; sin lock-in) |
| Relaying on-chain | EOA único self-relay | ⚠️ (ver §5) |

---

## 4. Fortalezas arquitectónicas

1. **UX sin seed phrase ni gas** - la barrera #1 de cripto, resuelta de raíz.
2. **El server no custodia la clave de firma** - la autoridad real es la passkey on-chain.
3. **Separación de capas limpia** (cliente / API / contratos / config compartida).
4. **Portabilidad de red** - direcciones por red en `shared/networks.ts`.
5. **Recovery social con timelock** - diferenciador real frente a wallets de un solo factor.
6. **Edge-native** - Workers escalan horizontalmente sin que toques nada.

---

## 5. Escalabilidad - análisis honesto

**Veredicto: la capa web/edge escala sola; la capa de relaying on-chain NO. Ese es el techo.**

### 5.1 Cuello de botella dominante: el relayer EOA único 🔴

La EOA operativa (`PRIVATE_KEY`) envía `handleOps`, despliega cuentas, fondea el
faucet y ejecuta mints CCTP. El guardian y los firmantes de paymaster/router son
roles separados y mainnet rechaza configuraciones que reutilicen claves.

Por qué es un techo:

- **Los nonces de un EOA son estrictamente secuenciales.** Un lease D1 común por
  red+firmante coordina hoy `handleOps`, CCTP y operaciones de cuenta, por lo que
  ya no colisionan. Esto preserva correctitud, pero no elimina el techo de
  throughput de una sola EOA.
- **Punto único de disponibilidad.** Si esa clave se compromete puede gastar su
  ETH/USDC operativo; ya no controla guardian ni firma sponsorships. Si se
  pierde, el relaying sigue detenido hasta rotarla.
- **No escala horizontalmente.** Los Workers escalan infinito, pero todos embudan a un EOA.

**Cómo se arregla (acotado, no reescritura):**

- **Opción A (recomendada): delegar a un bundler ERC-4337 real** (Pimlico / Alchemy / Stackup / Candide). El proyecto reimplementó un mini-bundler (`handleOps` a mano). Un bundler de verdad te da mempool, estimación de gas, reintentos y paralelismo; tú conservas tu paymaster. Es el camino estándar de la industria para escalar AA.
- **Opción B: pool de EOAs relayer** con un nonce manager (round-robin de N claves) si quieres seguir self-relaying.
- **Least privilege:** faucet y relayer ya usan claves y leases distintos; migrar
  a un servicio de firma/pool sigue siendo una opción de escala.
- **Guardian:** la clave dedicada ya está implementada; para alto valor sigue
  recomendado un multisig/MPC/HSM.

### 5.2 Reconstrucción de historial en cada poll - ✅ RESUELTO

_(Original)_ `GET /user/transactions` reconstruía historial llamando al explorer o escaneando logs por RPC **en cada request**, con polling cada 15s por usuario → ~4N llamadas/min a un API externo, sin caché.

**Resuelto:** el historial ahora se sirve desde la tabla **`ledger`** en D1 (escrita al relayar cada operación; ambos lados en transferencias internas) y un **cron indexer** (`services/indexer.ts`, cada 2 min) ingiere los depósitos externos con cursor en `sync_state`. `/user/transactions` ya **no toca RPC/explorer** en el request - solo D1. (El balance sigue on-chain: 2-4 `eth_call` baratos.)

### 5.3 Espera síncrona del recibo en el request - ✅ RESUELTO

Pagos, cuenta, faucet y recovery devuelven 202 con `txHash`/`userOpHash`; el
cliente consulta estado y reconciliadores cron verifican receipts/eventos y
finalizan D1. La única espera restante está dentro del job CCTP, no de HTTP.

### 5.4 Dependencia de un solo RPC - ✅ RESUELTO

`RPC_URL` acepta varias URLs y viem hace failover. CCTP admite además RPCs por
cadena en `CCTP_RPC_URLS`; producción debe configurar proveedores redundantes.

### 5.5 Cloudflare D1 🟢 (por ahora)

D1 aguanta de sobra esta escala (millones de filas). A vigilar a largo plazo: throughput de escritura, límite de tamaño por DB y latencia de escritura monorregión. El `DELETE` de `pending_payments` por `expires_at` está indexado y es barato.

### 5.6 Sin cola / reintentos / idempotencia - ✅ RESUELTO

D1 conserva máquinas de estado, claims, transacciones raw, intentos CCTP y
outbox; los jobs cron recuperan muertes entre broadcast y persistencia. Los
compare-and-set e índices únicos hacen idempotente la liquidación.

### Resumen de escalabilidad por horizonte

| Horizonte | ¿Aguanta hoy? | Cambio mínimo necesario |
| --- | --- | --- |
| Demo / pocos usuarios | ✅ | - |
| Cientos concurrentes | ⚠️ | Medir saturación del relayer y RPC; escalar firmantes/bundler |
| Miles+ | 🔴 | Bundler real (o pool de relayers) + indexer + colas |

---

## 6. Seguridad y modelo de confianza

- **Custodia:** ✅ el server no guarda la clave de firma; la passkey on-chain es la autoridad. Bien.
- **Guardian centralizado:** ⚠️ existe una clave dedicada con timelock y
  cancelación; para alto valor sigue pendiente multisig/MPC/HSM o recuperación
  social.
- **Claves por rol:** ✅ mainnet exige relayer, guardian, paymaster signer y
  router signer distintos; deployer permanece fuera del Worker.
- **Normalización low-s P256:** ✅ correcta (OpenZeppelin).
- **Validación de inputs:** ✅ usernames con regex + reservados; montos/wallets normalizados.
- **CORS:** ✅ allowlist configurable y mainnet falla cerrado si falta.
- **Rate limiting:** ✅ Turnstile + límites D1 fail-closed en rutas monetarias;
  las reglas de zona Cloudflare siguen siendo defensa operacional adicional.
- **`qx`/`qy` en localStorage:** 🟡 ver §8 - limita la portabilidad real de cuentas multi-passkey entre dispositivos.

---

## 7. Plataforma: ¿Web, PWA o app nativa?

### El principio que decide todo

**El corazón de Parmelia es el link de cobro.** Un pagador recibe una URL/QR y debe poder pagar con **fricción mínima**. Ese flujo es **inherentemente web**: clic en el link → pagar. Obligar a instalar (PWA o nativa) **antes** de pagar destruiría la conversión, que es justo el punto del producto.

De ahí se separan dos lados con necesidades distintas:

- **Lado pagador (recibe link/QR):** debe ser **web pura, sin instalar**. Innegociable.
- **Lado comerciante / usuario recurrente (crea links, ve saldo/historial a diario):** se beneficia de una experiencia instalada.

### ¿Forzar PWA? - No. Ofrecerla, sí.

- **Passkeys:** WebAuthn funciona igual en navegador y en PWA instalada (autenticador de plataforma). La PWA **no desbloquea** capacidad nueva de passkeys, pero sí aporta: ícono en home, modo standalone ("se siente app"), y web push (iOS 16.4+ / Android) para "te pagaron".
- **Recomendación:** hacer la app **instalable como PWA** (manifest + service worker para el app-shell + prompt de instalación para usuarios logueados recurrentes), pero **no forzar** la instalación. Es barato, sube retención del comerciante y **no toca** el funnel del pagador.
- La passkey vive bajo el RP ID = dominio; la PWA comparte dominio, así que las passkeys se conservan. ✅

**Veredicto PWA:** ✅ añadir ahora, como capa opcional de retención. ❌ no obligar.

### ¿App nativa? - Todavía no; sí más adelante y para el comerciante.

- **A favor:** APIs nativas de passkeys + secure enclave (almacenamiento de passkey más robusto), push fiable de pagos, mejor cámara/QR, biometría, presencia y confianza en las tiendas, deep links.
- **En contra:** es un **segundo cliente** (costo real), fricción de review en stores, y **no reemplaza la web** (los pagadores seguirán pagando por link en web).
- **Requisito técnico clave:** compartir passkeys entre web y nativa exige asociar el dominio (Apple App Site Association + Android Digital Asset Links) al **mismo RP ID**. Hay que planearlo desde el principio.
- **Recomendación:** **no para el MVP.** Tiene sentido **después de product-market fit**, enfocada en el **comerciante** (usuario frecuente, push de cobros), reutilizando la misma API del Worker. Si se hace, Expo / React Native (ya tienen las skills de RN instaladas) + mismo RP ID + push es el camino. El flujo del pagador se queda en web **siempre**.

### Estrategia de plataforma recomendada

1. **Web = capa universal** (pagadores y todos). Optimizar este flujo por encima de todo.
2. **PWA instalable ahora** (push + standalone) para retención del comerciante. Sin forzar.
3. **Nativa después de PMF**, para el comerciante, compartiendo API y RP ID de passkeys.

| Plataforma | ¿Cuándo? | Para quién | Prioridad |
| --- | --- | --- | --- |
| Web | Ya (es la base) | Todos, sobre todo pagadores | 🔴 Máxima |
| PWA | Ahora (capa encima) | Comerciantes recurrentes | 🟠 Alta |
| Nativa | Post-PMF | Comerciantes | 🟢 Baja (futuro) |

---

## 8. Deuda técnica priorizada

| # | Tema | Severidad | Acción |
| --- | --- | --- | --- |
| 1 | Relayer EOA único (throughput + SPOF) | 🔴 | Bundler real o pool de relayers; separar claves por rol |
| 2 | ~~Historial reconstruido en cada poll~~ | ✅ | Ledger D1 + indexer cron |
| 3 | ~~`waitForReceipt` dentro del request~~ | ✅ | 202 + polling + reconciliadores |
| 4 | ~~Sin cola/idempotencia en pagos~~ | ✅ | Estado durable D1 + CAS + outbox |
| 5 | Guardian centralizado | 🟠 | Clave dedicada hecha; multisig/MPC/HSM para alto valor |
| 6 | Sin rate limiting de zona | 🟡 | **Turnstile ✅ hecho** en crear cuenta + faucet; `ALLOWED_ORIGINS` ✅. Falta rate-limit de zona (regla Cloudflare con dominio propio) |
| 7 | ~~`qx`/`qy` solo en localStorage~~ | ✅ | Tabla `passkeys` y resolución server/on-chain por credential ID |
| 8 | ~~Sin tests de server~~ | ✅ Hecho | 129 pruebas Node + 10 en workerd/D1 |
| 9 | ~~RPC único~~ | ✅ Hecho | `RPC_URL` acepta múltiples URLs con failover (viem `fallback`) |
| 10 | ~~Bundle pesado del cliente~~ | ✅ Hecho | Code-splitting por ruta (jsqr/ScanQR ya no carga en el inicio) |

> Nota sobre #7: las coordenadas públicas se guardan en `passkeys` y el submit
> resuelve por `credentialId` o por el set on-chain; no son material secreto.

---

## 9. Roadmap técnico recomendado

**Corto plazo (endurecer el MVP):**
- Aplicar migraciones/despliegues pendientes y ejecutar smoke autenticado real.
- Configurar métricas, alertas, budgets y ensayo de backup/restore D1.
- Rotar la credencial Firebase retirada y completar runbooks de incidentes.

**Medio plazo (camino a producto):**
- Migrar self-relay → **bundler ERC-4337** (o pool de relayers + nonce manager).
- Ensayar rotación de las claves separadas de faucet y relayer.
- Sustituir guardian EOA por multisig/MPC/HSM para alto valor.
- Mantener pruebas de fork y QA autenticado como gates de release.

**Largo plazo (escala y diferenciación):**
- Indexer dedicado para historial/analytics.
- Guardian descentralizado (multisig / guardians plurales).
- App nativa para comerciantes (post-PMF), mismo RP ID + push.
- Multi-red en producción (ya hay portabilidad): elegir red(es) de settlement según fees/liquidez de USDC.

---

## 10. Veredicto final

Parmelia está **bien construido y bien apostado**: el stack es correcto, el diseño de wallet (AA + passkeys + gas patrocinado + recovery) es sofisticado y encaja con el producto, y la portabilidad reciente lo libera del lock-in de red. **Sí sirve para el producto que quiere ser.**

Lo que lo separa de "demo" a "producto" no es rehacerlo, sino desplegar y
operar con disciplina la capa ya endurecida, y escalar el **relaying on-chain**
cuando una EOA coordinada deje de dar el throughput necesario.

En plataforma: **web primero y siempre** para el pagador, **PWA ahora** para retención sin forzar instalación, y **nativa después de PMF** para el comerciante. No obligues a instalar nada para pagar: eso es lo único que el producto no se puede permitir.
