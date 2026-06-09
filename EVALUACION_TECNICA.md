# Evaluación Técnica de Parmelia

> Documento de evaluación de ingeniería: stack, arquitectura, escalabilidad,
> seguridad y estrategia de plataforma (web / PWA / app nativa).
> Fecha: junio 2026. Basado en revisión del código de `client/`, `server/`,
> `contracts/` y `shared/`.

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

### 3.1 Frontend — ✅ correcto

React 19, Vite 7, TypeScript 5.9, Tailwind v4, SWR, react-router. Stack moderno, mantenible y con buen DX. El bundle (~712 KB / 231 KB gzip) es algo pesado por Firebase + viem; mejorable con code-splitting (`React.lazy` por ruta, importar viem selectivamente), pero no es bloqueante.

### 3.2 Backend — ✅ correcto

Hono sobre Cloudflare Workers. Excelente para una API de borde: latencia global baja, escalado horizontal automático, costo bajo. El código está modularizado (rutas + servicios + middlewares) y, tras la última limpieza, sin duplicación relevante. `viem` es la librería web3 correcta.

### 3.3 Datos — ✅ correcto

Cloudflare D1 (SQLite) para metadata de la app (perfiles, links, pending ops, historial). La migración previa de KV → D1 fue la decisión correcta: el dominio es **relacional** (usuarios ↔ links ↔ pagos) y D1 da consultas, índices y FKs que KV no puede. Schema con tablas `STRICT`, FKs e índices adecuados.

### 3.4 Contratos / Account Abstraction — ✅ correcto y sofisticado

- **ERC-4337** (EntryPoint, UserOperations, paymaster) — estándar de AA.
- **AccountWebAuthnV2**: MultiSigner (ERC-7913) + ejecución (ERC-7821) + UUPS + recovery con guardian y timelock.
- **WebAuthn/P256** vía verificador ERC-7913 stateless.
- **27 tests de Foundry** sobre la V2 — el único módulo con cobertura real de tests.

Esto es un diseño de wallet de calidad: passkeys múltiples en la misma dirección, recuperación social con ventana de 48h, y upgradeabilidad. Para un producto de pagos sin seed phrase, es exactamente lo que se necesita.

### 3.5 Identidad — ✅ pragmático

Firebase Auth + Google login. Correcto para MVP: separa **identidad** (quién es la persona en la app) de **custodia** (la passkey firma on-chain; el server no tiene la clave). El acoplamiento a Google es una dependencia a vigilar, no un error.

### 3.6 Red — ✅ con asterisco

Monad Testnet: EVM de alto throughput y fees bajos → alineado con pagos. Asteriscos: es una L1 joven (madurez de ecosistema, finalidad, liquidez de USDC real, herramientas de indexación). El riesgo se mitigó con la **refactorización de portabilidad** reciente: hoy cambiar de cadena (Base, Arbitrum, Avalanche) es agregar una entrada de config + desplegar contratos. Eso es estratégicamente importante: no estás casado con Monad.

### Veredicto por capa

| Capa | Tecnología | Veredicto |
| --- | --- | --- |
| Frontend | React 19 / Vite / Tailwind v4 | ✅ |
| API | Hono / Cloudflare Workers | ✅ |
| Datos | Cloudflare D1 | ✅ |
| Web3 | viem | ✅ |
| Wallet | ERC-4337 + WebAuthn + ERC-7913/7821 + UUPS | ✅ |
| Identidad | Firebase Auth (Google) | ✅ (acoplamiento a vigilar) |
| Red | Monad (portable) | ✅⚠️ (L1 joven, pero ya no es lock-in) |
| Relaying on-chain | EOA único self-relay | ⚠️ (ver §5) |

---

## 4. Fortalezas arquitectónicas

1. **UX sin seed phrase ni gas** — la barrera #1 de cripto, resuelta de raíz.
2. **El server no custodia la clave de firma** — la autoridad real es la passkey on-chain.
3. **Separación de capas limpia** (cliente / API / contratos / config compartida).
4. **Portabilidad de red** — direcciones por red en `shared/networks.ts`.
5. **Recovery social con timelock** — diferenciador real frente a wallets de un solo factor.
6. **Edge-native** — Workers escalan horizontalmente sin que toques nada.

---

## 5. Escalabilidad — análisis honesto

**Veredicto: la capa web/edge escala sola; la capa de relaying on-chain NO. Ese es el techo.**

### 5.1 Cuello de botella dominante: el relayer EOA único 🔴

Hoy un solo EOA (`PRIVATE_KEY`) hace **todo** lo on-chain: enviar `handleOps` de cada pago, desplegar cada cuenta nueva, mandar el faucet, y además es el **guardian** de todas las wallets.

Por qué es un techo:

- **Los nonces de un EOA son estrictamente secuenciales.** Dos pagos concurrentes de dos usuarios distintos compiten por el mismo nonce. Bajo concurrencia real hay colisiones de nonce: una tx falla, se reordena o hay que serializar todo. El throughput práctico queda en ~1 transacción en vuelo por ese EOA → unos pocos TPS en el mejor caso, y bastante menos porque cada request **espera el recibo** (§5.3).
- **Punto único de falla / seguridad.** Si esa clave se compromete: puede drenar el depósito del paymaster (gas), desplegar, y proponer recovery sobre cualquier cuenta. Si se pierde: el servicio cae.
- **No escala horizontalmente.** Los Workers escalan infinito, pero todos embudan a un EOA.

**Cómo se arregla (acotado, no reescritura):**

- **Opción A (recomendada): delegar a un bundler ERC-4337 real** (Pimlico / Alchemy / Stackup / Candide). El proyecto reimplementó un mini-bundler (`handleOps` a mano). Un bundler de verdad te da mempool, estimación de gas, reintentos y paralelismo; tú conservas tu paymaster. Es el camino estándar de la industria para escalar AA.
- **Opción B: pool de EOAs relayer** con un nonce manager (round-robin de N claves) si quieres seguir self-relaying.
- **Least privilege de claves:** separar deployer / faucet / guardian / relayer en claves distintas. Hoy una sola clave concentra todo.
- **Sacar el guardian de la clave caliente del relayer** (clave dedicada o guardian multisig/contrato).

### 5.2 Reconstrucción de historial en cada poll 🟠

`GET /user/transactions` reconstruye historial llamando al explorer (monadscan) o escaneando logs por RPC **en cada request**, y `Home` hace polling **cada 15s por usuario activo** (balance cada 10s). Con N usuarios activos eso son ~4N llamadas/min a un API externo → rate limits, latencia y costo. Sin caché.

**Fix:** cachear historial (D1/KV/edge cache con TTL corto) y/o mover a un **indexer** (Ponder, subgraph, Goldsky). Ya guardas enviados/recibidos en D1: apóyate más en eso y reconcilia con la cadena **en background** (Cron Triggers / Queues), no en el path del request.

### 5.3 Espera síncrona del recibo en el request 🟠

`prepare` y `submit` hacen `waitForTransactionReceipt` dentro del request. Eso mantiene la petición abierta hasta que la tx entra en bloque: mala UX en bloques lentos y serializa aún más el relayer.

**Fix:** `submit` devuelve `txHash`/`userOpHash` de inmediato y el cliente hace polling de estado; el manejo del recibo va asíncrono (Cloudflare Queues / Durable Objects).

### 5.4 Dependencia de un solo RPC 🟠

`RPC_URL` único; cada `prepare` hace varios round-trips (nonce, gasPrice, getUserOpHash, balance) y `submit` agrega simulate + send + wait. El propio código nota límites de RPC gratis (getLogs de 10 bloques).

**Fix:** RPC con failover/redundancia, batching y caché de `gasPrice`.

### 5.5 Cloudflare D1 🟢 (por ahora)

D1 aguanta de sobra esta escala (millones de filas). A vigilar a largo plazo: throughput de escritura, límite de tamaño por DB y latencia de escritura monorregión. El `DELETE` de `pending_payments` por `expires_at` está indexado y es barato.

### 5.6 Sin cola / reintentos / idempotencia 🟠

Si `submit` falla a medias (tx enviada pero recibo nunca confirmado), no hay reconciliación ni reintento; el `pending` solo expira. Para dinero, esto necesita una cola con idempotencia.

### Resumen de escalabilidad por horizonte

| Horizonte | ¿Aguanta hoy? | Cambio mínimo necesario |
| --- | --- | --- |
| Demo / pocos usuarios | ✅ | — |
| Cientos concurrentes | ⚠️ | Sacar `waitForReceipt` del request + cachear historial |
| Miles+ | 🔴 | Bundler real (o pool de relayers) + indexer + colas |

---

## 6. Seguridad y modelo de confianza

- **Custodia:** ✅ el server no guarda la clave de firma; la passkey on-chain es la autoridad. Bien.
- **Guardian centralizado:** ⚠️ el EOA del server es guardian de **todas** las cuentas. Puede *proponer* recovery sobre cualquiera (mitigado por timelock 48h + cancelación del usuario), pero es una suposición de confianza fuerte y concentra poder. A futuro: guardian dedicado / multisig / esquema de guardians plurales.
- **Una sola clave para todo:** 🔴 ver §5.1; least privilege pendiente.
- **Normalización low-s P256:** ✅ correcta (OpenZeppelin).
- **Validación de inputs:** ✅ usernames con regex + reservados; montos/wallets normalizados.
- **CORS `*`:** 🟡 aceptable porque la auth real es por token Firebase + firma WebAuthn; aun así conviene restringir orígenes como defensa en profundidad.
- **Sin rate limiting** en endpoints sensibles (`create`, `fund`) más allá de flags por uid. Añadir rate limiting (Workers + D1/KV o Turnstile) antes de abrir al público.
- **`qx`/`qy` en localStorage:** 🟡 ver §8 — limita la portabilidad real de cuentas multi-passkey entre dispositivos.

---

## 7. Plataforma: ¿Web, PWA o app nativa?

### El principio que decide todo

**El corazón de Parmelia es el link de cobro.** Un pagador recibe una URL/QR y debe poder pagar con **fricción mínima**. Ese flujo es **inherentemente web**: clic en el link → pagar. Obligar a instalar (PWA o nativa) **antes** de pagar destruiría la conversión, que es justo el punto del producto.

De ahí se separan dos lados con necesidades distintas:

- **Lado pagador (recibe link/QR):** debe ser **web pura, sin instalar**. Innegociable.
- **Lado comerciante / usuario recurrente (crea links, ve saldo/historial a diario):** se beneficia de una experiencia instalada.

### ¿Forzar PWA? — No. Ofrecerla, sí.

- **Passkeys:** WebAuthn funciona igual en navegador y en PWA instalada (autenticador de plataforma). La PWA **no desbloquea** capacidad nueva de passkeys, pero sí aporta: ícono en home, modo standalone ("se siente app"), y web push (iOS 16.4+ / Android) para "te pagaron".
- **Recomendación:** hacer la app **instalable como PWA** (manifest + service worker para el app-shell + prompt de instalación para usuarios logueados recurrentes), pero **no forzar** la instalación. Es barato, sube retención del comerciante y **no toca** el funnel del pagador.
- La passkey vive bajo el RP ID = dominio; la PWA comparte dominio, así que las passkeys se conservan. ✅

**Veredicto PWA:** ✅ añadir ahora, como capa opcional de retención. ❌ no obligar.

### ¿App nativa? — Todavía no; sí más adelante y para el comerciante.

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
| 2 | Historial reconstruido en cada poll | 🟠 | Caché / indexer + reconciliación en background |
| 3 | `waitForReceipt` dentro del request | 🟠 | Respuesta inmediata + polling de estado async |
| 4 | Sin cola/idempotencia en pagos | 🟠 | Cloudflare Queues + claves idempotentes |
| 5 | Guardian = clave caliente del server | 🟠 | Guardian dedicado / multisig |
| 6 | Sin rate limiting público | 🟠 | Rate limit + Turnstile antes de abrir (CORS ya es configurable vía `ALLOWED_ORIGINS` ✅) |
| 7 | `qx`/`qy` solo en localStorage | 🟡 | Guardar el set de signers (clave pública, no secreta) server-side para portabilidad multi-dispositivo |
| 8 | ~~Sin tests de server~~ | ✅ Hecho | Vitest + 18 tests sobre validación, `normalizeLowS` y `serializeBigInts` |
| 9 | ~~RPC único~~ | ✅ Hecho | `RPC_URL` acepta múltiples URLs con failover (viem `fallback`) |
| 10 | ~~Bundle pesado del cliente~~ | ✅ Hecho | Code-splitting por ruta (jsqr/ScanQR ya no carga en el inicio) |

> Nota sobre #7: hoy, una passkey **sincronizada** en un dispositivo **nuevo** no tiene `qx`/`qy` en localStorage; para wallets **multi-passkey** eso hace fallar `/pay/submit` (el caso de un solo signer se infiere on-chain). Es una limitación real de la promesa "passkey sincronizada = cuenta portátil".

---

## 9. Roadmap técnico recomendado

**Corto plazo (endurecer el MVP):**
- Sacar `waitForReceipt` del request + cachear historial (quita el dolor de escalabilidad inmediato).
- Rate limiting + restringir CORS.
- Tests con Vitest de la lógica de firma/normalización.

**Medio plazo (camino a producto):**
- Migrar self-relay → **bundler ERC-4337** (o pool de relayers + nonce manager).
- Separar claves por rol (deployer/faucet/guardian/relayer).
- Cola con idempotencia para pagos; reconciliación en background.
- PWA instalable con push.

**Largo plazo (escala y diferenciación):**
- Indexer dedicado para historial/analytics.
- Guardian descentralizado (multisig / guardians plurales).
- App nativa para comerciantes (post-PMF), mismo RP ID + push.
- Multi-red en producción (ya hay portabilidad): elegir red(es) de settlement según fees/liquidez de USDC.

---

## 10. Veredicto final

Parmelia está **bien construido y bien apostado**: el stack es correcto, el diseño de wallet (AA + passkeys + gas patrocinado + recovery) es sofisticado y encaja con el producto, y la portabilidad reciente lo libera del lock-in de red. **Sí sirve para el producto que quiere ser.**

Lo que lo separa de "demo" a "producto" no es rehacerlo, sino **resolver la capa de relaying on-chain** (el EOA único) y **sacar las esperas/agregaciones del path del request**. Son cambios acotados y de manual.

En plataforma: **web primero y siempre** para el pagador, **PWA ahora** para retención sin forzar instalación, y **nativa después de PMF** para el comerciante. No obligues a instalar nada para pagar: eso es lo único que el producto no se puede permitir.
