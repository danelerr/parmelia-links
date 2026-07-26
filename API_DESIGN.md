# Parmelia API — Diseño de la infraestructura de cobros

> Diseño (no implementación) de la API de Parmelia como **infraestructura de
> cobros stablecoin con liquidación local**: "Stripe/MercadoPago para dólares
> digitales on-chain". El objeto central es el **Payment Intent**.
>
> Parmelia ya está en producción sobre Arbitrum (no es un MVP): esta es una
> evolución del producto existente, no un arranque de cero. El doc marca fases
> **Ahora / Siguiente / Horizonte**, no "MVP vs después".
> Fecha: junio 2026. Relacionado: `ARCHITECTURE.md`, `DEFI_DESIGN.md`.
>
> **Estado de implementación (jul-2026):** Flujo A (lazo cerrado) y Flujo B
> (PaymentRouter) **construidos y operativos en test mode**: merchants, API keys
> (`sk_`), payment intents (con `expires_at` aplicado), webhooks firmados con
> outbox + claim atómico + reintentos con backoff, event log, idempotencia
> (incl. carrera de `Idempotency-Key`), sandbox "simular pago", el contrato
> `ParmeliaPaymentRouter` **desplegado en Arbitrum Sepolia** (`0x607f…`;
> `payInvoiceWithPermit` llega con el próximo redeploy, feature-flagged), su
> firma de autorización, el indexer que reconcilia `InvoicePaid`, y el
> **dashboard de comerciantes** (keys, pagos con paginación, webhooks con
> reenvío, sandbox). Referencia pública: `docs/api.md` + `docs/openapi.yaml`.
> Estado vivo: `CLAUDE_REVIEW_FABLE.md`.

---

## 1. Qué resuelve y posicionamiento

La API convierte **transferencias on-chain sueltas** en **cobros ordenados,
atribuibles, confirmables y notificables**. Tres dolores que mata:

1. **Pagos sin orden** — en crypto recibes USDC sin saber a qué compra pertenece.
   El Payment Intent ata cada pago a un `order_id` / `invoice_id` del comercio.
2. **UX de wallet** — passkeys + gas patrocinado + checkout alojado (ya resuelto).
3. **Falta de integración estándar** — no existe un `POST /payments` + webhook
   para stablecoins. Ese es el hueco.

**Moat doble:** vs Stripe/MercadoPago → rieles stablecoin (global, en dólares,
sin contracargos, fee bajo); vs crypto crudo → orden, conciliación, webhooks y
cero-blockchain para el usuario final. **La API es el producto** (la integran
devs); la app/wallet es la superficie de consumo.

## 2. Usuarios (dos personas)

- **Comerciante no-dev:** dashboard + payment link + QR, cero código. Tiendas,
  freelancers, profesores, food trucks.
- **Desarrollador:** API keys + webhooks + checkout sessions. SaaS, e-commerce,
  **bots de Telegram/WhatsApp** (clave en LatAm), marketplaces, edtech.

Diseñar para el dev, pero que el comerciante viva solo con dashboard + link.

## 3. Lo que ya existe y se reutiliza

No se parte de cero — buena parte del modelo ya está en el sistema actual:

| Concepto API | Estado actual |
|---|---|
| Payment Intent | Germen en `payment_links` (id, amount, currency, status, tx_hash, paid_at, paid_by). Se **generaliza**, no se inventa. |
| Checkout alojado | Páginas `/pay?id=` y `/:username`. |
| Confirmación on-chain | Ingestión push/backfill bajo demanda + `/pay/submit` (pago Parmelia-nativo atado al intent). |
| Dirección determinística por intent | `AccountFactoryV2.predictAddress` (CREATE2) ya permite derivar direcciones counterfactual. |
| Ledger / conciliación interna | Tabla `ledger` (in/out, kind, tx_hash, token, amount, contraparte). |
| Whitelist de activos | USDC / ETH / WBTC en `shared/networks.ts`. |
| **Nuevo en la API** | merchant/account, api_keys, payment_intent (rico), checkout_session, webhook_endpoint, event log, sandbox, dashboard de integración. |

## 4. Concepto central: el Payment Intent

Es el objeto estable alrededor del cual gira todo. Propiedades:

- Identidad: `id` (`pi_...`), `merchant_id`, `created_at`, `expires_at`.
- Económicas: `amount`, `currency` (USDC primero), `amount_received`, `fee`.
- Estado: `status` (ver §6), `payment_method` / `allowed_methods[]` (§10).
- Atribución: `metadata` (JSON del comercio), `reference`.
- Cobro: `deposit_address` (Modelo B), `checkout_url`, `tx_hash` (al pagar).
- Idempotencia: `idempotency_key` con el que se creó.

Regla de oro: **todo cobro de comercio crea un Payment Intent**, incluso si el
pagador usa saldo Parmelia. Esa es la única forma de garantizar orden y
conciliación. Los envíos P2P casuales pueden seguir fuera del sistema de intents.

## 5. La decisión núcleo: cómo se atribuye un pago a un intent

Es la pieza que define si esto es "Stripe-like" o "solo P2P con API". Hay **dos
flujos**, ambos soportados. **Flujo A está construido**; **Flujo B** es el plan
para que pague cualquiera. En EVM no hay campo "memo", así que cada flujo resuelve
de forma distinta el atar un pago a su intent.

### Flujo A (= Modelo A) — el pagador es usuario Parmelia

El cobrador genera un QR/Link; el pagador lo abre **con la app Parmelia** y paga
con su passkey. Parmelia arma la transacción, así que **sabe** a qué intent
pertenece (atribución perfecta) y el paymaster patrocina el gas. El pagador
**tiene que ser usuario Parmelia** (o crear su cuenta en el momento).

```
[Cobrador] crea cobro pi_123  →  comparte QR / Link
       │
[Pagador Parmelia] abre el link en la app  →  confirma con passkey
       │  (el backend arma el UserOp; Parmelia ya sabe que es pi_123)
       ▼
EntryPoint v0.9 ─► AccountWebAuthnV2 (pagador) ─► USDC.transfer ─► AccountWebAuthnV2 (cobrador)
       ▲                                                              (− fee ─► Tesorería Parmelia)
ParmeliaPaymaster patrocina el gas
       │
backend marca pi_123 = paid  →  webhook payment.paid (firmado)
```
Contratos: `EntryPoint v0.9`, `AccountWebAuthnV2` (pagador y cobrador), `USDC`,
`ParmeliaPaymaster`. No hace falta router (Parmelia arma la tx). **Ya implementado:**
el cobro se respalda en un `payment_links` y el gancho vive en `/pay/submit`.

### Flujo B (= Modelo B) — paga cualquier wallet externa

Para que pague **alguien sin cuenta Parmelia** (Metamask, un exchange, otra dapp).
La atribución se resuelve con el contrato **PaymentRouter** (§5.1): el pagador
llama `payInvoice(pi_123, ...)` y el USDC va **directo a la cuenta del cobrador**,
con un evento que ata el pago al intent. Parmelia nunca toca los fondos.

```
[Cobrador] crea cobro pi_123  →  comparte QR / Link
       │
[Pagador externo] abre el checkout  →  su wallet firma:
   (a) USDC.approve(PaymentRouter, X)
   (b) PaymentRouter.payInvoice(pi_123, USDC, X)
       │
       ▼
PaymentRouter:  transferFrom(pagador →)   X − fee ─► AccountWebAuthnV2 (cobrador)
                                          fee     ─► Tesorería Parmelia
                emite InvoicePaid(pi_123, payer, token, amount, merchant, fee)
       │
indexer escucha InvoicePaid  →  marca pi_123 = paid  →  webhook payment.paid
```
Contratos: `USDC`, `PaymentRouter` (nuevo), `AccountWebAuthnV2` (cobrador),
tesorería. El pagador **paga su propio gas**. **No-custodial.** Contrato, firma de
autorización (`GET /v1/payment_intents/:id/onchain`) e indexer (escucha
`InvoicePaid`) **ya implementados**; falta **desplegar** `ParmeliaPaymentRouter`.

### 5.1 Contrato PaymentRouter (Parmelia, no-custodial)

Patrón **ya validado en AvaSettle** (proyecto hermano sobre Avalanche), con UN
cambio clave: AvaSettle envía a una **tesorería de la plataforma** (custodial);
Parmelia envía **directo a la smart account del comercio** (no-custodial).

```solidity
payInvoice(bytes32 intentId, IERC20 token, uint256 amount, address merchant, bytes metadata)
```
- token whitelisted + `amount ≥ minAmount` (anti-dust).
- guard `invoicePaid[intentId]` → un intent no se paga dos veces.
- `transferFrom(payer → merchant, amount − fee)` y, si `feeBps > 0`,
  `transferFrom(payer → treasury, fee)`. El destino `merchant` es la cuenta del
  **cobrador**, no una caja de Parmelia.
- emite `InvoicePaid(intentId, payer, token, amount, merchant, fee, metadata)`.
- `Ownable2Step` + `Pausable` + `ReentrancyGuard`; `emergencyWithdraw` solo dueño.

**Seguridad del destino:** `merchant` no puede venir libre del pagador (podría
redirigir el cobro). Opciones: (a) registrar on-chain el `merchant` esperado por
`intentId` antes de cobrar; (b) que el contrato lea un registro firmado por
Parmelia. A definir al implementar — es la decisión central del contrato.

**Alternativa (sin contrato):** dirección de depósito única por intent (forwarder
CREATE2, o EOA HD con barrido como hace AvaSettle). Más simple para el pagador
(una transferencia normal), pero reintroduce barrido + gas + custodia. El router
es la opción **no-custodial** preferida para Parmelia.

### 5.2 Finalidad y montos (Flujo B)
- **Política de finalidad:** ¿cuándo es `paid`? En Arbitrum el sequencer confirma
  casi instantáneo, pero hay riesgo de reorg hasta finalidad L1 (~minutos).
  `confirmation_policy` por tramo de monto (chicos = inclusión del sequencer;
  grandes = N confirmaciones). Nunca prometer "instantáneo siempre".
- **Monto exacto:** con el router el `amount` lo fija el intent; si el evento trae
  un monto distinto del esperado → `under_review`. (En la variante de dirección de
  depósito hay que manejar under/overpayment explícitamente.)

### Quién paga el gas
- Flujo A (pagador Parmelia): gas **patrocinado** por el paymaster.
- Flujo B (wallet externa): el pagador paga su propio gas (ya es usuario crypto)
  — por eso el Flujo B es **más barato de operar** para Parmelia.

## 6. Máquina de estados (mínima, accionable)

```
created ──► awaiting_payment ──► processing ──► paid ──► settled
               │                     │
               ├──► expired          └──► under_review
               └──► canceled
                                     paid ──► refunded   (Horizonte)
```

| Estado | Significado |
|---|---|
| `created` | Intent creado, aún sin checkout abierto. |
| `awaiting_payment` | Checkout/dirección listos, esperando fondos. |
| `processing` | Pago visto on-chain, esperando la `confirmation_policy`. |
| `paid` | Confirmado según política; fondos disponibles para el comercio. |
| `settled` | Barrido/liquidado al comercio (hoy "paid" ya deja fondos en la cuenta; `settled` cobra sentido con payout/off-ramp). |
| `under_review` | Monto inesperado / timeout raro / revisión. |
| `expired` | No se pagó antes de `expires_at`. |
| `canceled` | Cancelado por el comercio (solo antes de `paid`). |
| `failed` | Fallo real de ejecución (no usar para "expiró"). |
| `refunded` | Horizonte. En crypto un refund es un pago nuevo en reversa, no una reversión. |

Evitar estados que no se accionan. No modelar un autómata de 12 estados.

## 7. Modelo de datos (esquema ilustrativo, estilo D1/STRICT)

> Bocetos para fijar el modelo — no es el SQL final. Reusa convenciones actuales
> (STRICT, FKs, timestamps ISO UTC).

```
merchants            id (mer_), owner_uid (FK users), name, country,
                     default_settlement (wallet | bank_bo | bobt), created_at

api_keys             id (ak_), merchant_id (FK), prefix (pk_live/sk_live/...),
                     secret_hash, mode (test|live), scopes, last_used_at,
                     revoked_at, created_at

payment_intents      id (pi_), merchant_id (FK), amount, currency,
                     amount_received, fee, status, payment_method,
                     allowed_methods (JSON), metadata (JSON), reference,
                     deposit_address, checkout_url, tx_hash,
                     idempotency_key, mode, expires_at, created_at, updated_at

payment_links        id (plink_), merchant_id (FK), amount (nullable=abierto),
                     currency, reference, active, created_at
                     -- generaliza la tabla payment_links actual

checkout_sessions    id (cs_), intent_id (FK), url, status, expires_at,
                     branding (JSON), created_at

webhook_endpoints    id (whe_), merchant_id (FK), url, secret, enabled_events
                     (JSON), status, created_at

events               id (evt_), merchant_id (FK), type, object_id, payload
                     (JSON), mode, created_at   -- log inmutable, fuente de webhooks

webhook_deliveries   id, event_id (FK), endpoint_id (FK), attempt, status,
                     response_code, next_retry_at, delivered_at  -- outbox

settlements          (Horizonte) id (set_), merchant_id, amount, method,
                     status, tx_hash | bank_ref, created_at

refunds              (Horizonte) id (re_), intent_id, amount, status, tx_hash
```

Notas:
- `metadata` es JSON opaco del comercio (`order_id`, `user_id`, `invoice_id`,
  `product_id`); se devuelve íntegro en el objeto y en cada webhook. Máx ~4-8 KB.
  No hacerlo consultable arbitrariamente; a lo sumo 1-2 claves indexables.
- `mode` (test|live) en cada fila → aislamiento total entre sandbox y producción.

## 8. Superficie de la API (REST, versionada en `/v1`)

```
POST   /v1/payment_intents                 crear cobro
GET    /v1/payment_intents/:id             consultar
GET    /v1/payment_intents                 listar/filtrar (status, metadata)
POST   /v1/payment_intents/:id/cancel      cancelar (si no pagado)

POST   /v1/payment_links                   link reutilizable / monto abierto
POST   /v1/checkout_sessions               sesión de checkout alojado

POST   /v1/webhook_endpoints               registrar endpoint
GET    /v1/webhook_endpoints
DELETE /v1/webhook_endpoints/:id

GET    /v1/events                          event log
GET    /v1/events/:id
POST   /v1/events/:id/resend               reenviar webhook

GET    /v1/balance                         saldo de la cuenta

POST   /v1/refunds                         (Horizonte)
POST   /v1/payouts                         (Horizonte: retiro a banco/BOBT)
```

Respuesta de crear intent (boceto):
```json
{
  "id": "pi_abc123",
  "status": "awaiting_payment",
  "amount": "25.00",
  "currency": "USDC",
  "checkout_url": "https://pay.parmelia.me/c/cs_xyz",
  "deposit_address": "0x...",
  "expires_at": "2026-06-14T15:00:00Z",
  "metadata": { "order_id": "A-1042" }
}
```

## 9. Autenticación de la API

Hoy la auth es Firebase JWT (humano de la app). La API necesita auth
**máquina-a-máquina** nueva:

- **Claves secretas** `sk_live_...` / `sk_test_...` en `Authorization: Bearer`
  para llamadas servidor-a-servidor. Se guarda solo el **hash** (nunca en claro).
- **Claves publicables** `pk_live_...` para inicializar checkout desde el cliente
  (alcance limitado: crear/leer sesión, no listar ni mover fondos).
- **Scopes** por clave; rotación y `revoked_at`.
- El dashboard (autenticado con Firebase, el dueño) gestiona keys/webhooks/logs.

## 10. Multi-método sin reescribir (extensibilidad)

El intent es **agnóstico del método**. Campo `payment_method` / `allowed_methods[]`;
el intent es el contrato estable y los métodos se enchufan debajo:

`usdc_onchain` → `parmelia_balance` → `bobt_balance` → `qr_bank_bo`
→ conversión `usdc↔bobt` → `bank_withdrawal`.

Esto es el **moat de liquidación local** (BOBT, QR bancario boliviano, off-ramp a
banco) y es casi todo Horizonte. Pero si el intent nace method-agnostic, sumarlos
no rompe la API. La conversión USDC↔BOBT reutiliza la infra de swaps + una capa
de FX/settlement.

## 11. Webhooks (la integración real)

**Eventos (Ahora):** `payment.created`, `payment.processing`, `payment.paid`,
`payment.expired`, `payment.failed`, `payment.under_review`, `checkout.completed`.
**Horizonte:** `payment.refunded`, `settlement.created`, `settlement.completed`.

**Seguridad (modelo probado, no reinventar):**
- **Firma HMAC-SHA256** sobre el body crudo + header `Parmelia-Timestamp`; secreto
  por endpoint.
- **Anti-replay:** tolerancia de timestamp (~5 min) + `event.id` único.
- **Idempotencia:** el receptor descarta `event.id` ya procesado.
- **Reintentos** con backoff exponencial; **logs de entrega** + botón "reenviar".

**Infra de entrega (decisión consciente, encaja con el stack):** el outbox D1
(`webhook_deliveries`) es la fuente durable y `SCHEDULED_JOBS_QUEUE` transporta
trabajo. Una transición que crea una entrega despierta el scheduler; el job se
reprograma sólo hasta entregar o agotar intentos. No existe polling vacío.

## 12. Idempotencia de requests

Header `Idempotency-Key` en los POST (crear intent, refund). Misma clave →
misma respuesta, sin duplicar cobros. Se persiste en `payment_intents.idempotency_key`.

## 13. Sandbox vs producción

Cae natural por la config de dos cadenas:
- **Sandbox** = Arbitrum Sepolia + claves `*_test` + **botón "simular pago"**
  (marca `paid` sin on-chain real → el dev prueba sus webhooks en minutos sin
  conseguir USDC de testnet). Crítico para adopción de devs.
- **Producción** = Arbitrum One + claves `*_live`.
- Aislamiento total de datos por `mode`.

## 14. Integración con la Wallet/Cuenta Parmelia

`parmelia_balance` es solo otro `payment_method`. Pagar a un comercio desde saldo
Parmelia **igual crea un Payment Intent** (no se salta el sistema). Así la wallet
suma fricción cero sin que se pierda orden ni conciliación. Los envíos P2P
casuales pueden vivir fuera de intents; los cobros, nunca.

## 15. Roadmap por fases (no "MVP")

**Ahora — núcleo de la API:**
1. [x] merchant/account + API keys (test/live, secreto hasheado SHA-256). — `merchant.routes.ts`, `services/apiKeys.ts`, `middlewares/apiAuth.ts`.
2. [x] Payment Intent (respaldado por `payment_links`; metadata, idempotencia, expiración). — `routes/v1.routes.ts`.
3. [x] Checkout vía link + QR (reusa la página `/pay`); `checkout_url` en el intent. ([ ] checkout_session con branding propio = Siguiente.)
4. [x] Confirmación on-chain **Flujo A** (gancho en `/pay/submit`) **y Flujo B**
   (`ParmeliaPaymentRouter` + firma `services/paymentRouter.ts` + `GET .../onchain`
   + `runRouterWatcher` que escucha `InvoicePaid`). Pendiente: **desplegar** el
   router on-chain + `confirmation_policy` por tramo de monto.
5. [x] Webhooks (outbox `webhook_deliveries` + Queue dirigida por eventos + firma HMAC + reintentos con backoff + idempotencia) + event log. — `services/webhooks.ts`, migración `0002_api.sql`.
6. [x] Sandbox con "simular pago": `POST /v1/payment_intents/:id/simulate_payment` (solo claves `test`) marca `paid` y dispara el webhook sin on-chain.
7. [ ] Dashboard de integración (los endpoints `/merchant/keys` y `/merchant/webhooks` existen; falta la UI).

**Implementado en este pase:** `POST /v1/payment_intents` (+ `GET`, `cancel`),
`GET /v1/events`, gestión `/merchant/keys` y `/merchant/webhooks` (Firebase auth),
eventos `payment.created` y `payment.paid`, entrega de webhooks firmados por
outbox+Queue. Migración `0002_api.sql` (merchants, api_keys, payment_intents,
webhook_endpoints, events, webhook_deliveries).

**Siguiente:**
- Refunds / cancelaciones; under/overpayment con pagos parciales.
- Settlement explícito (barrido a cuenta de comercio) y `payout`.
- Búsqueda por metadata; reporting/conciliación exportable.
- SDK JS oficial + docs interactivos.

**Horizonte (moat local):**
- BOBT como saldo, QR bancario boliviano, conversión USDC↔BOBT, retiros a banco.
- Suscripciones/recurrentes, splits de marketplace, sub-cuentas tipo Connect,
  invoicing.

## 16. Qué evitar sobre-diseñar

- No construir refunds, settlement, BOBT ni suscripciones en la fase Ahora.
- No "Connect"/multi-tenant marketplace todavía.
- No máquina de 12 estados; la de §6 basta.
- No metadata consultable arbitrariamente.
- D1 conserva el estado durable; Queue transporta y el Durable Object compacta
  alarmas, sin convertir la cola en fuente de verdad.
- No tokens arbitrarios — mantener whitelist (USDC primero).
- No prometer finalidad instantánea: elegir y documentar `confirmation_policy`.
- No SDKs en 5 lenguajes el día 1 — REST limpio + buenos docs + **un** SDK JS.

## 17. Riesgos y decisiones abiertas

- **Atribución on-chain (§5)** es el punto con más enjundia: dirección única por
  intent (forwarder CREATE2 vs EOA HD) — especificar a nivel de contrato.
- **Política de finalidad** — definir tramos de monto y confirmaciones.
- **Custodia del barrido** — quién controla las direcciones de depósito y cómo se
  barre sin introducir un punto único de robo (relacionado con la separación de
  claves de `DEPLOY.md §11`).
- **Auth máquina-a-máquina** — subsistema nuevo (keys, hashing, scopes, rotación).
- **Entrega de webhooks** — outbox D1 + Queue/alarma sólo mientras haya trabajo.

## 18. Modelo de negocio (cómo se monetiza)

Mismo modelo que Stripe/MercadoPago — **comisión por pago exitoso (% del
volumen)** — pero sobre rieles stablecoin, donde liquidar cuesta centavos (no hay
redes de tarjetas). Eso permite cobrar mucho menos y aun así tener gran margen.

**1. Fee por transacción (el núcleo).** Un % por cobro cobrado, tomado en la
**misma transacción**:
- **Flujo B:** el `PaymentRouter` manda `monto − fee` al comercio y `fee` a la
  tesorería (visible on-chain).
- **Flujo A:** el fee va en el batch del UserOp. Infra ya existente:
  `PARMELIA_FEES_ENABLED`, `PARMELIA_SWAP_FEE_BPS`, `PARMELIA_TREASURY_ADDRESS`,
  hard cap 1% en código.
- Referencia: Stripe ~2.9% + $0.30; MercadoPago más. A **0.5%–1%** eres mucho más
  barato y rentable. Ej.: un comercio con $10.000/mes a 1% = $100/mes. El negocio
  es **volumen × comercios**.

**2. Spread de on/off-ramp (el moat grande, a futuro).** Al sumar USDC↔BOBT, QR
bancario y retiros a banco, se toma un spread (~0.5%–1.5%). En LatAm el dinero
real está en la **rampa fiat**, no en el movimiento on-chain.

**3. Secundarios:** fee de swap (ya implementado, off por defecto), spread de
depósitos cross-chain, fee de payout, y planes/SaaS (límites más altos,
sub-cuentas, reporting) más adelante.

**Sin float:** Parmelia es **no-custodial** (los fondos quedan en la cuenta del
usuario), así que no se gana reteniendo saldos como un banco. El análogo legítimo
es el **performance fee** del Earn (sobre el rendimiento, no el principal).

**Costo:** el gas. Flujo A lo patrocina Parmelia (centavos en Arbitrum, cubierto
de sobra por el fee); Flujo B lo paga el pagador (costo cero). Las fees se muestran
**antes de confirmar** (ya se hace en swaps) y tienen hard cap en código.

---

### Lectura de fondo

Parmelia ya tiene ~60-70% del modelo (payment_links, checkout, indexer, factory,
ledger). El trabajo no es inventar la API, es **generalizar el intent + agregar la
capa de integración** (API keys, webhooks, eventos, sandbox) y **resolver la
atribución on-chain** (dirección única por intent + política de finalidad). El
riesgo no es técnico sino de foco: cerrar el núcleo (§15 Ahora) con comercios
reales integrados antes de tocar BOBT/settlement/refunds.
