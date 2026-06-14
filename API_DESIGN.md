# Parmelia API — Diseño de la infraestructura de cobros

> Diseño (no implementación) de la API de Parmelia como **infraestructura de
> cobros stablecoin con liquidación local**: "Stripe/MercadoPago para dólares
> digitales on-chain". El objeto central es el **Payment Intent**.
>
> Parmelia ya está en producción sobre Arbitrum (no es un MVP): esta es una
> evolución del producto existente, no un arranque de cero. El doc marca fases
> **Ahora / Siguiente / Horizonte**, no "MVP vs después".
> Fecha: junio 2026. Relacionado: `ARCHITECTURE.md`, `DEFI_DESIGN.md`.

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
| Confirmación on-chain | Cron indexer (ingiere USDC entrante al ledger) + `/pay/submit` (pago Parmelia-nativo atado al intent). |
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

Es la pieza que define si esto es "Stripe-like" o "solo P2P con API". Dos modelos,
ambos soportados:

### Modelo A — pago mediado por Parmelia (lazo cerrado)
El pagador usa su cuenta Parmelia (passkey) en el checkout; Parmelia construye la
transferencia, así que **sabe** a qué intent pertenece. Ya existe. Reconciliación
perfecta, gas patrocinado. Ideal para usuarios Parmelia y P2P.

### Modelo B — pago abierto desde cualquier wallet (Metamask, exchange)
Lo que hace que pague **cualquiera sin cuenta Parmelia**. En EVM no hay campo
"memo", así que la atribución se hace por **dirección de depósito única por
Payment Intent**:

1. Al crear el intent se deriva una `deposit_address` única (CREATE2, vía la
   factory) — **counterfactual**: no se despliega nada hasta que llega dinero.
2. El indexer vigila esa dirección. Cuando entra USDC ≥ `amount`, atribuye el
   pago al intent por dirección destino.
3. Se barre (sweep) el USDC al **settlement** del comercio y se dispara el webhook.

**Mecanismo recomendado:** un contrato "forwarder" minimal por intent en una
dirección CREATE2 (patrón clásico de direcciones de depósito de exchanges), que
reenvía el USDC entrante al comercio. Alternativa interim más simple: EOAs
efímeras derivadas de una semilla HD del servidor (el server barre). Tradeoff:
el forwarder es más limpio y casi sin custodia; la EOA HD es más rápida de
construir pero el server custodia claves efímeras. **Esto es lo primero a
especificar en detalle** cuando pasemos a contrato.

### Dos problemas que el Modelo B obliga a decidir desde el diseño
- **Política de finalidad:** ¿cuándo es `paid`? En Arbitrum el sequencer confirma
  casi instantáneo, pero hay riesgo de reorg hasta finalidad L1 (~minutos).
  Diseño: `confirmation_policy` por tramo de monto (montos chicos = inclusión del
  sequencer; montos grandes = N confirmaciones / finalidad). Configurable y
  documentado, nunca prometido como "instantáneo siempre".
- **Under/overpayment:** un pagador externo puede mandar de más o de menos →
  estado `under_review` y, a futuro, pagos parciales. La dirección-por-intent lo
  hace tratable (sabes exactamente cuánto llegó a esa dirección).

### Quién paga el gas
- Modelo A (pagador Parmelia): gas patrocinado por el paymaster.
- Modelo B (wallet externa): el pagador paga su propio gas (ya es usuario crypto).

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

**Infra de entrega (decisión consciente, encaja con el stack):** webhooks
confiables quieren cola con reintentos. Cloudflare Queues es de pago; el patrón
**outbox (`webhook_deliveries`) + cron** (ya se usa cron para el indexer) entrega
y reintenta gratis. Si más adelante se justifica Queues, se migra sin cambiar el
contrato externo.

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
1. merchant/account + API keys (test/live, secreto hasheado).
2. Payment Intent rico (generaliza `payment_links`).
3. Checkout session alojado + link + QR.
4. Confirmación USDC on-chain: Modelo A ya; **dirección única por intent
   (Modelo B)** + `confirmation_policy`.
5. Webhooks (outbox + cron + firma + reintentos + idempotencia) + event log.
6. Sandbox con "simular pago".
7. Dashboard de integración: keys, endpoints, logs, reenviar evento.

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
- No infra propia de colas si outbox+cron alcanza.
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
- **Entrega de webhooks** — outbox+cron ahora; evaluar Queues con volumen.

---

### Lectura de fondo

Parmelia ya tiene ~60-70% del modelo (payment_links, checkout, indexer, factory,
ledger). El trabajo no es inventar la API, es **generalizar el intent + agregar la
capa de integración** (API keys, webhooks, eventos, sandbox) y **resolver la
atribución on-chain** (dirección única por intent + política de finalidad). El
riesgo no es técnico sino de foco: cerrar el núcleo (§15 Ahora) con comercios
reales integrados antes de tocar BOBT/settlement/refunds.
