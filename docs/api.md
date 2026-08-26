# GatoPago Payments API

Accept USDC from Arbitrum, Base, or Avalanche with an intent-based flow: create a
**Payment Intent**, share one **checkout link or QR**, and receive the merchant's
chosen settlement in Arbitrum plus a signed webhook. The payer chooses a wallet;
GatoPago selects only routes supported by the source chain.

- **Payments base URL:** `https://gatopago-payments-api.parmelia.workers.dev`
- **Temporary compatibility proxy:** `https://server.parmelia.workers.dev`
- **Version:** all endpoints are under `/v1`.
- **Content type:** `application/json` (request and response).
- **Get your keys:** create API keys and register webhooks in the dashboard at
  `https://dashboard.parmelia.me`.

> The Phase 2 code is implemented locally, but the new Worker and D1 are not
> deployed by this change. Until the controlled cutover, use the compatibility
> host of the environment being tested. Mainnet remains disabled.

---

## Authentication

Authenticate every `/v1` request with a secret API key in the `Authorization`
header:

```
Authorization: Bearer sk_test_your_key_here
```

- Keys come in two modes:
  - `sk_test_…` — **test mode**, settles on Arbitrum Sepolia. Use it to build and
    to drive the [sandbox](#test-mode--sandbox).
  - `sk_live_…` — **live mode futuro**. El Dashboard no permite crearla hoy y
    el backend responde `503 SERVICE_UNAVAILABLE` si una clave histórica intenta
    crear un cobro. Habilitarla exige flag, settlement mainnet y al menos una
    ruta mainnet desplegada y activa en el manifest. Build against test mode today.
- The secret is shown **once**, at creation, in the dashboard. Store it securely;
  only its hash is kept server-side. If leaked, revoke it in the dashboard.
- Never expose `sk_` keys in client-side code. They are server-to-server only.

A missing or invalid key returns `401` with a stable code:

```json
{ "error": "Invalid or revoked API key.", "error_code": "INVALID_API_KEY", "requestId": "…" }
```

---

## Quickstart

```bash
# 1. Create a payment intent for 25 USDC, tagged with your order id.
curl -X POST https://gatopago-payments-api.parmelia.workers.dev/v1/payment_intents \
  -H "Authorization: Bearer sk_test_xxx" \
  -H "Content-Type: application/json" \
  -d '{"amount":"25.00","currency":"USDC","metadata":{"order_id":"A-1042"}}'
```

```json
{
  "id": "pi_3b1c…",
  "object": "payment_intent",
  "status": "awaiting_payment",
  "amount": "25.00",
  "amount_atomic": "25000000",
  "currency": "USDC",
  "reference": null,
  "metadata": { "order_id": "A-1042" },
  "checkout_url": "https://app.parmelia.me/pay?id=…",
  "tx_hash": null,
  "mode": "test",
  "expires_at": "2026-06-16T15:00:00.000Z",
  "created_at": "2026-06-16T14:00:00.000Z"
}
```

2. Show the `checkout_url` to your customer (render it as a QR, or link to it).
3. When the customer pays, GatoPago sends a signed `payment.paid` webhook to your
   registered endpoint, with your `metadata` echoed back. Deliver the product.

---

## Payment flows

A payment intent has one public checkout. A GatoPago account uses the local
Arbitrum router; an external wallet first requests a quote for its chain and
then receives an EIP-712 attempt authorization. Base supports Fast or Standard
CCTP; Avalanche is Standard-only. The merchant still settles USDC on Arbitrum.

### Flow A — pay with a GatoPago account (optional)

The customer opens `checkout_url`, chooses their GatoPago balance and pays with
their passkey. Gas is sponsored. The public checkout defaults to an external
wallet and never requires login unless the payer explicitly chooses this method.

### Flow B — pay from an external wallet

The checkout creates an attempt-scoped browser capability, calls
`POST /checkout/{linkId}/quotes`, proves control of the quoted payer by signing
the returned message, and reserves exactly one signed attempt with
`POST /checkout/{linkId}/attempts`. It broadcasts the indicated local or CCTP
router call and reports the source transaction. Payments accepts that hash only
after independently verifying its receipt, sender, router and exact event. Router watchers can
recover the attempt from its on-chain event even if the browser closes before
registration. GatoPago does not hold payer funds between transactions.

---

## Payment economics

GatoPago's commercial default is **zero platform fees**. An absent
`PAYMENT_FEE_POLICY_JSON` resolves to the immutable `free-default` policy; a
non-zero environment value on its own does not activate charging. CCTP network
fees, when applicable, are rail costs paid to Circle and are never reported as
GatoPago revenue.

The intent `amount` and `settlement_amount_atomic` are the merchant's net
receivable. The payer's maximum is calculated independently:

```text
gross_payer_amount_atomic
  = settlement_amount_atomic
  + platform_fee_atomic
  + cctp_fee_atomic
```

Every quote returns the matched versioned policy, platform fee, CCTP ceiling,
gross payer amount, bearer and deployed router cap. Reserving an attempt copies
those values into `fee_snapshot`; later policy edits cannot rewrite an existing
signature or charge. `GET /v1/payment_intents/{id}` returns `fee_breakdown`
when evidence exists, with separate `platform` and `network` lines plus quoted
and actual totals. The same breakdown is included in paid/overpaid webhook
payloads so merchants can reconcile without inferring fees from transfer
deltas.

A positive platform-fee rule is rejected unless all of these are true:

- the rule is explicit, unambiguous and at most 100 bps;
- `PAYMENT_PLATFORM_FEE_RECIPIENT` is valid;
- the declared route and immutable deployed router cap permit it;
- on-chain preflight confirms code, signer, USDC, treasury, pause state and
  route-specific CCTP configuration immediately before authorization.

This capability exists for a future scoped exception; it is not an active
commercial fee policy.

---

## Payment Intents

### The payment intent object

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique id, prefixed `pi_`. |
| `object` | string | Always `"payment_intent"`. |
| `status` | string | See [statuses](#statuses). |
| `amount` | string | Decimal amount, e.g. `"25.00"`. |
| `currency` | string | Asset symbol, e.g. `"USDC"`. |
| `reference` | string \| null | Your free-text note (≤200 chars). |
| `metadata` | object | Your opaque key/values, echoed in webhooks. |
| `checkout_url` | string | Hosted checkout link (Flow A). |
| `tx_hash` | string \| null | Settlement evidence hash once paid. |
| `mode` | string | `test` or `live`. |
| `fee_breakdown` | object \| null | Platform and network fee evidence on the detail endpoint. |
| `expires_at` | string | ISO 8601 UTC. |
| `created_at` | string | ISO 8601 UTC. |

### Statuses

| Status | Meaning |
|---|---|
| `awaiting_payment` | Created, waiting for the customer to pay. |
| `paid` | Payment confirmed; funds are in the merchant's account. Fires `payment.paid`. |
| `overpaid` | Confirmed output exceeded the intended amount. Fires `payment.overpaid`. |
| `processing` | Source execution is confirmed and settlement is still advancing. |
| `canceled` | Canceled by the merchant before payment. |
| `expired` | Past `expires_at` without payment. _(Auto-expiry is roadmap; treat `expires_at` as advisory and cancel intents you no longer want.)_ |

### Create a payment intent

`POST /v1/payment_intents`

| Body field | Required | Description |
|---|---|---|
| `amount` | yes | Decimal string, e.g. `"25.00"`. Must be > 0. |
| `currency` | no | Asset symbol; defaults to `USDC`. Must be supported on the active chain. |
| `metadata` | no | Object of your own keys (`order_id`, `invoice_id`, …). Max 8 KB. |
| `reference` | no | Short note (≤200 chars). |
| `expires_at` | no | ISO timestamp within the next seven days. Default: one hour. |

Headers:

- `Idempotency-Key` _(optional, recommended)_ — retrying with the same key
  returns the original intent instead of creating a duplicate.

Returns `201` with the payment intent (or `200` if an idempotent replay matched).

```bash
curl -X POST https://gatopago-payments-api.parmelia.workers.dev/v1/payment_intents \
  -H "Authorization: Bearer sk_test_xxx" \
  -H "Idempotency-Key: order-A-1042" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "25.00",
    "currency": "USDC",
    "reference": "Order A-1042",
    "metadata": { "order_id": "A-1042", "customer_id": "u_88" },
    "expires_at": "2026-08-24T18:00:00.000Z"
  }'
```

### Retrieve a payment intent

`GET /v1/payment_intents/{id}` → the payment intent object (or `404`).

### List payment intents

`GET /v1/payment_intents` → `{ "object": "list", "data": [ … ] }` (most recent first).

### Cancel a payment intent

`POST /v1/payment_intents/{id}/cancel` → the updated intent.
Only valid while `awaiting_payment`; otherwise returns `409 INTENT_NOT_PAYABLE`.

### Quote and authorize an external-wallet attempt (Flow B)

The canonical flow is public and scoped to the checkout link:

1. `GET /checkout/{linkId}` lists only enabled chains and routes.
2. Generate a random 32-byte capability in the browser and keep it only in
   `sessionStorage`. `POST /checkout/{linkId}/quotes` with `payer`,
   `source_chain_id`, its SHA-256 as `attempt_capability_hash`, optional
   `route`, and `amount` when the intent has `amount_mode=payer_defined`. CCTP
   quotes use Circle's live fee response and fail closed if it is
   stale, unavailable, or malformed. The response also contains
   `platform_fee_atomic`, `cctp_fee_atomic`, `gross_payer_amount_atomic`,
   `fee_policy`, `platform_fee_bps`, `platform_fee_bearer`,
   `platform_fee_recipient`, and `route_fee_cap_bps`.
3. Ask that exact payer to `personal_sign` the returned `payer_proof_message`.
   `POST /checkout/{linkId}/attempts` with `quote_id`,
   `payer_proof_signature`, the required `Idempotency-Key` and the raw capability
   in `X-GatoPago-Checkout-Capability`. Only one unexpired attempt can be active.
4. Build calldata from the returned `router`, `authorization`, and `signature`;
   do not create calldata before the attempt exists.
5. After the wallet sees a successful receipt, call
   `POST /checkout/{linkId}/attempts/{attemptId}/register` with
   `source_tx_hash` and the same capability header. A pending receipt returns
   `409` without persisting the hash; mismatched sender/router/event is rejected.
   The watcher can still recover the attempt from its on-chain event if this
   request never arrives.

Reading, registering or canceling an attempt requires the same capability and
returns `404` for a missing or incorrect value. An active-attempt conflict never
reveals the winner's authorization. Reservations without a broadcast can be
canceled immediately; stale `submitted` rows expire automatically if canonical
evidence never appears.

The signature binds payer, merchant, source chain, route, exact settlement
amount, fee ceiling, validity window, metadata and router. `GET
/v1/payment_intents/{id}/onchain` remains only as an N-1 compatibility endpoint
and requires `payer` plus `source_chain_id`; new integrations should not use it.

### Simulate a payment (test mode)

`POST /v1/payment_intents/{id}/simulate_payment`

**Test keys only.** Marks the intent `paid` without any on-chain payment and fires
the `payment.paid` webhook — so you can build and verify your webhook handler in
minutes without acquiring testnet funds. Returns `400 SANDBOX_ONLY` with a live
key, `409 INTENT_NOT_PAYABLE` if not awaiting payment.

```bash
curl -X POST https://gatopago-payments-api.parmelia.workers.dev/v1/payment_intents/pi_3b1c…/simulate_payment \
  -H "Authorization: Bearer sk_test_xxx"
```

---

## Events

Every state change is recorded as an immutable event (the source of webhooks).

### The event object

```json
{
  "id": "evt_…",
  "merchantId": "mer_…",
  "type": "payment.paid",
  "objectId": "pi_3b1c…",
  "payload": { "...": "the payment intent object" },
  "mode": "test",
  "createdAt": "2026-06-16T14:05:00.000Z"
}
```

- `GET /v1/events` → `{ "object": "list", "data": [ … ] }`
- `GET /v1/events/{id}` → the event (or `404`).

### Event types

| Type | Fires when |
|---|---|
| `payment.paid` | A payment intent is confirmed paid (Flow A, Flow B, or sandbox). |
| `payment.overpaid` | Confirmed settlement exceeded the intended amount. |

_(Roadmap: `payment.expired`, `payment.failed`, `payment.refunded`.)_

---

## Webhooks

Register your endpoint URL in the dashboard; you receive a **signing secret**
(`whsec_…`) once. GatoPago POSTs each event to your URL.

### Request

```
POST <your endpoint>
Content-Type: application/json
GatoPago-Signature: v1=<hmac-sha256 hex>
GatoPago-Timestamp: <unix seconds>
GatoPago-Event-Id: evt_…
GatoPago-Delivery-Id: whd_…
```

Body:

```json
{
  "id": "evt_…",
  "type": "payment.paid",
  "data": {
    "id": "pi_3b1c…",
    "object": "payment_intent",
    "status": "paid",
    "amount": "25.00",
    "currency": "USDC",
    "reference": "Order A-1042",
    "metadata": { "order_id": "A-1042" },
    "tx_hash": "0x…",
    "mode": "test",
    "fee_breakdown": {
      "currency": "USDC",
      "platform": {
        "type": "platform",
        "bearer": "none",
        "quoted_amount_atomic": "0",
        "actual_amount_atomic": "0",
        "recipient": null,
        "status": "waived",
        "policy_id": "free-default",
        "policy_version": 1,
        "rule_id": "free-default"
      },
      "network": {
        "type": "network",
        "bearer": "none",
        "quoted_amount_atomic": "0",
        "actual_amount_atomic": "0",
        "recipient": null,
        "status": "waived",
        "policy_id": "sandbox",
        "policy_version": 1,
        "rule_id": "free-default"
      },
      "total_quoted_atomic": "0",
      "total_actual_atomic": "0"
    }
  }
}
```

### Verifying the signature

Compute `HMAC-SHA256(secret, "<timestamp>.<raw body>")` and compare, in constant
time, to the `GatoPago-Signature` header. Reject stale timestamps to prevent
replay. Persist `GatoPago-Event-Id` as a unique key before applying the business
effect: delivery is at-least-once, so a timeout or crash may produce the same
event again under the same event ID. `GatoPago-Delivery-Id` identifies the
physical endpoint delivery for support and retry diagnostics.

```js
import crypto from "node:crypto";

export function verifyGatoPagoWebhook(rawBody, headers, secret) {
  const ts = headers["gatopago-timestamp"];
  const signature = headers["gatopago-signature"]?.replace(/^v1=/, "");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw new Error("Invalid signature");

  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error("Stale webhook");

  return JSON.parse(rawBody);
}
```

> Verify against the **raw request body**, byte-for-byte. Re-serializing the JSON
> will change the bytes and break the signature.

### Idempotency & retries

- **Deduplicate** by the body `id`: the same event may
  be delivered more than once.
- **Respond `2xx` quickly** (under ~10s). Do slow work asynchronously.
- On any non-`2xx` (or timeout), GatoPago retries with exponential backoff,
  capped at one hour. After eight delivery attempts it enters `dead` for
  operator/manual replay. Deliveries and their logical event survive restarts.

---

## Metadata

`metadata` is an opaque object you control (e.g. `order_id`, `invoice_id`,
`product_id`, `customer_id`). It is stored on the intent and returned **verbatim**
in the object and in every webhook, so you can reconcile the payment in your own
system. Max ~8 KB.

## Idempotency

Send `Idempotency-Key` on `POST /v1/payment_intents`. The same key always returns
the first intent created with it, so safe retries never double-charge.

## Test mode / sandbox

- Use `sk_test_…` keys. Test data is isolated from live (`mode` on every object).
- Drive the full lifecycle without funds via
  [`simulate_payment`](#simulate-a-payment-test-mode).
- Test settles on Arbitrum Sepolia. Live will settle on Arbitrum One once its
  contracts are deployed (not yet operational; see Authentication).

---

## Errors

Errors use standard HTTP status codes and a JSON body:

```json
{
  "error": "Human-readable message.",
  "error_code": "STABLE_CODE",
  "requestId": "…"
}
```

- `error` — human message (may change; do not parse).
- `error_code` — stable, machine-readable. Branch on this.
- `requestId` — include it in support requests so we can find the log.

| HTTP | `error_code` | Meaning |
|---|---|---|
| 400 | `INVALID_AMOUNT` | `amount` missing or ≤ 0. |
| 400 | `UNSUPPORTED_CURRENCY` | `currency` not supported on the active chain. |
| 400 | `INVALID_METADATA` | `metadata` is not an object or exceeds 8 KB. |
| 400 | `INVALID_EXPIRY` | `expires_at` is invalid or outside the next seven days. |
| 400 | `CHAIN_DISABLED` | The requested source chain is not enabled. |
| 400 | `QUOTE_STALE` | The quote or its live fee observation expired. |
| 400 | `SANDBOX_ONLY` | `simulate_payment` called with a live key. |
| 401 | `UNAUTHENTICATED` | Missing `Authorization: Bearer sk_…` header. |
| 404 | `INTENT_NOT_FOUND` | No such payment intent for this account. |
| 404 | `EVENT_NOT_FOUND` | No such event for this account. |
| 409 | `INTENT_NOT_PAYABLE` | Intent is not in a state that allows the action (already paid, canceled, or past `expires_at`). |
| 409 | `ATTEMPT_ACTIVE` | Another unexpired attempt already reserves the intent. |
| 503 | `FEE_UNAVAILABLE` | Circle did not provide a current valid fee; no hidden fallback was used. |
| 503 | `INVALID_FEE_POLICY` | The versioned platform-fee policy is malformed or incomplete. |
| 503 | `AMBIGUOUS_FEE_POLICY` | Top-priority rules disagree; GatoPago refuses to choose silently. |
| 503 | `INVALID_ROUTE_CAPABILITY` | The static route capability or immutable cap is invalid. |
| 503 | `ROUTER_FEE_CAP_EXCEEDED` | The matched rule exceeds the deployed router ceiling. |
| 503 | `ROUTER_PREFLIGHT_REQUIRED` | A paid rule was requested without mandatory on-chain preflight. |
| 503 | `ROUTER_PREFLIGHT_FAILED` | Deployed router state differs from the signed execution assumptions. |
| 500 | `SERVER_ERROR` | Unexpected error on our side. Retry; if it persists, contact support with `requestId`. |

---

## Reference: on-chain (Flow B)

| Item | Value |
|---|---|
| Home/settlement test chain | Arbitrum Sepolia (`421614`) |
| Source test chains | Arbitrum Sepolia (`421614`), Base Sepolia (`84532`), Avalanche Fuji (`43113`) |
| Router | returned by `POST /checkout/{linkId}/attempts` |
| Local execution | `ParmeliaPaymentRouterV2.pay(PaymentAuthorization,signature)` after USDC approval/permit |
| CCTP execution | `ParmeliaCctpPaymentRouter.pay(CctpPaymentAuthorization,signature)`; Fast on Base, Standard on Base/Fuji |
| Recovery event | `PaymentSettled` or `CctpPaymentBurned`, each carrying the signed intent/attempt identifiers |
