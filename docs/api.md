# Parmelia Payments API

Accept stablecoin payments (USDC on Arbitrum) with a Stripe-style flow: create a
**Payment Intent**, share a **checkout link or QR**, and receive a signed
**webhook** when it's paid. No blockchain knowledge required from your customers.

- **Base URL:** `https://server.parmelia.workers.dev`
- **Version:** all endpoints are under `/v1`.
- **Content type:** `application/json` (request and response).
- **Get your keys:** create API keys and register webhooks in the dashboard at
  `https://dashboard.parmelia.me`.

> This reference documents what is live today. Items marked _(roadmap)_ are
> designed but not yet enabled.

---

## Authentication

Authenticate every `/v1` request with a secret API key in the `Authorization`
header:

```
Authorization: Bearer sk_live_your_key_here
```

- Keys come in two modes:
  - `sk_test_…` — **test mode**, settles on Arbitrum Sepolia. Use it to build and
    to drive the [sandbox](#test-mode--sandbox).
  - `sk_live_…` — **live mode**. Will settle on Arbitrum One; the Arbitrum One
    contracts are **not deployed yet**, so live mode is not operational — the API
    fails closed (`CONTRACT_NOT_DEPLOYED`) rather than pointing at placeholder
    addresses. Build against test mode today.
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
curl -X POST https://server.parmelia.workers.dev/v1/payment_intents \
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
3. When the customer pays, Parmelia sends a signed `payment.paid` webhook to your
   registered endpoint, with your `metadata` echoed back. Deliver the product.

---

## Payment flows

A payment intent can be paid two ways. You create the intent the same way for
both; the difference is who pays and how.

### Flow A — pay with a Parmelia account (default)

The customer opens `checkout_url` in Parmelia and pays with their passkey. Gas is
sponsored; nothing is needed from you beyond the `checkout_url`. Best when your
customers are (or will become) Parmelia users.

### Flow B — pay from any external wallet (on-chain)

Lets anyone pay from any wallet (MetaMask, an exchange withdrawal, another dapp)
without a Parmelia account, via the on-chain **PaymentRouter**. You request a
signed authorization and the payer's wallet calls the router. Funds go **directly
to the merchant**; Parmelia never custodies them. See
[On-chain authorization](#get-an-on-chain-authorization-flow-b).

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
| `tx_hash` | string \| null | On-chain tx hash once paid. |
| `mode` | string | `test` or `live`. |
| `expires_at` | string | ISO 8601 UTC. |
| `created_at` | string | ISO 8601 UTC. |

### Statuses

| Status | Meaning |
|---|---|
| `awaiting_payment` | Created, waiting for the customer to pay. |
| `paid` | Payment confirmed; funds are in the merchant's account. Fires `payment.paid`. |
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
| `expires_in` | no | Seconds until expiry, 60–86400. Default 3600. |

Headers:

- `Idempotency-Key` _(optional, recommended)_ — retrying with the same key
  returns the original intent instead of creating a duplicate.

Returns `201` with the payment intent (or `200` if an idempotent replay matched).

```bash
curl -X POST https://server.parmelia.workers.dev/v1/payment_intents \
  -H "Authorization: Bearer sk_test_xxx" \
  -H "Idempotency-Key: order-A-1042" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "25.00",
    "currency": "USDC",
    "reference": "Order A-1042",
    "metadata": { "order_id": "A-1042", "customer_id": "u_88" },
    "expires_in": 1800
  }'
```

### Retrieve a payment intent

`GET /v1/payment_intents/{id}` → the payment intent object (or `404`).

### List payment intents

`GET /v1/payment_intents` → `{ "object": "list", "data": [ … ] }` (most recent first).

### Cancel a payment intent

`POST /v1/payment_intents/{id}/cancel` → the updated intent.
Only valid while `awaiting_payment`; otherwise returns `409 INTENT_NOT_PAYABLE`.

### Get an on-chain authorization (Flow B)

`GET /v1/payment_intents/{id}/onchain`

Returns a Parmelia-signed authorization the payer's wallet uses to call the
PaymentRouter. The signature binds the chain, router, invoice, token, amount,
merchant and fee — the payer cannot change any of them.

```json
{
  "router": "0x…",
  "chainId": 421614,
  "invoiceId": "0x…",
  "token": "0x…",
  "amount": "25000000",
  "merchant": "0x…",
  "feeBps": 0,
  "deadline": 1750000000,
  "signature": "0x…",
  "call": {
    "function": "payInvoice(bytes32,address,uint256,address,uint256,uint256,bytes,bytes)",
    "args": "invoiceId, token, amount, merchant, feeBps, deadline, signature, metadata(0x)"
  },
  "callWithPermit": {
    "function": "payInvoiceWithPermit(bytes32,address,uint256,address,uint256,uint256,bytes,bytes,uint256,uint8,bytes32,bytes32)",
    "args": "…same first 8 args…, permitDeadline, v, r, s"
  }
}
```

`callWithPermit` is **only present when the deployed router on the active chain
supports it** (feature-flagged per network). Always feature-detect on the field
instead of assuming it: the currently deployed testnet router predates
`payInvoiceWithPermit`, so today the response carries `call` only.

The payer's wallet then sends two transactions on the active Arbitrum chain:

```solidity
// 1) allow the router to pull the tokens
USDC.approve(router, amount)

// 2) pay — funds go straight to `merchant`, fee (if any) to the treasury
PaymentRouter.payInvoice(invoiceId, token, amount, merchant, feeBps, deadline, signature, "0x")
```

**One transaction with permit (optional, when `callWithPermit` is present).** If
the token supports EIP-2612 (USDC does) and the deployed router exposes it, the
payer can skip the `approve` by signing a permit off-chain and calling
`payInvoiceWithPermit(...)` with the permit's `permitDeadline, v, r, s` appended —
a single transaction instead of two.

When the router's `InvoicePaid` event is observed, the intent flips to `paid` and
the `payment.paid` webhook fires. Notes:

- The payer pays their own gas (they are a crypto-native wallet).
- `amount` is in atomic units (USDC has 6 decimals → `25000000` = 25 USDC).
- Returns `400 ROUTER_DISABLED` if the router isn't deployed on the active chain.

### Simulate a payment (test mode)

`POST /v1/payment_intents/{id}/simulate_payment`

**Test keys only.** Marks the intent `paid` without any on-chain payment and fires
the `payment.paid` webhook — so you can build and verify your webhook handler in
minutes without acquiring testnet funds. Returns `400 SANDBOX_ONLY` with a live
key, `409 INTENT_NOT_PAYABLE` if not awaiting payment.

```bash
curl -X POST https://server.parmelia.workers.dev/v1/payment_intents/pi_3b1c…/simulate_payment \
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
| `payment.created` | A payment intent is created. |
| `payment.paid` | A payment intent is confirmed paid (Flow A, Flow B, or sandbox). |

_(Roadmap: `payment.expired`, `payment.failed`, `payment.refunded`.)_

---

## Webhooks

Register your endpoint URL in the dashboard; you receive a **signing secret**
(`whsec_…`) once. Parmelia POSTs each event to your URL.

### Request

```
POST <your endpoint>
Content-Type: application/json
Parmelia-Signature: <hmac-sha256 hex>
Parmelia-Timestamp: <unix seconds>
Parmelia-Event-Id: evt_…
```

Body:

```json
{
  "id": "evt_…",
  "type": "payment.paid",
  "created": "2026-06-16T14:05:00.000Z",
  "data": {
    "id": "pi_3b1c…",
    "object": "payment_intent",
    "status": "paid",
    "amount": "25.00",
    "currency": "USDC",
    "reference": "Order A-1042",
    "metadata": { "order_id": "A-1042" },
    "tx_hash": "0x…",
    "mode": "test"
  }
}
```

### Verifying the signature

Compute `HMAC-SHA256(secret, "<timestamp>.<raw body>")` and compare, in constant
time, to the `Parmelia-Signature` header. Reject stale timestamps to prevent
replay.

```js
import crypto from "node:crypto";

export function verifyParmeliaWebhook(rawBody, headers, secret) {
  const ts = headers["parmelia-timestamp"];
  const signature = headers["parmelia-signature"];
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

- **Deduplicate** by `id` (or the `Parmelia-Event-Id` header): the same event may
  be delivered more than once.
- **Respond `2xx` quickly** (under ~10s). Do slow work asynchronously.
- On any non-`2xx` (or timeout), Parmelia retries with backoff:
  ~1m → 5m → 30m → 2h → 6h → 24h (up to 6 attempts), then marks the delivery
  failed. Deliveries survive restarts.

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
| 400 | `METADATA_TOO_LARGE` | `metadata` exceeds 8 KB. |
| 400 | `INVALID_EXPIRY` | `expires_in` out of the 60–86400 range. |
| 400 | `NO_WALLET` | The merchant has no receiving wallet yet. |
| 400 | `ROUTER_DISABLED` | On-chain pay unavailable on the active chain. |
| 400 | `SANDBOX_ONLY` | `simulate_payment` called with a live key. |
| 401 | `UNAUTHENTICATED` | Missing `Authorization: Bearer sk_…` header. |
| 401 | `INVALID_API_KEY` | Malformed, unknown, or revoked API key. |
| 404 | `INTENT_NOT_FOUND` | No such payment intent for this account. |
| 404 | `EVENT_NOT_FOUND` | No such event for this account. |
| 409 | `INTENT_NOT_PAYABLE` | Intent is not in a state that allows the action (already paid, canceled, or past `expires_at`). |
| 500 | `CONTRACT_NOT_DEPLOYED` | The active chain's contracts are not deployed yet (live mode pre-launch). |
| 500 | `SERVER_ERROR` | Unexpected error on our side. Retry; if it persists, contact support with `requestId`. |

---

## Reference: on-chain (Flow B)

| Item | Value |
|---|---|
| Chain (test) | Arbitrum Sepolia (`421614`) |
| Chain (live) | Arbitrum One (`42161`) — contracts not deployed yet |
| PaymentRouter | returned by `GET /v1/payment_intents/{id}/onchain` (`router`) |
| `payInvoice` | `payInvoice(bytes32 invoiceId, address token, uint256 amount, address merchant, uint256 feeBps, uint256 deadline, bytes signature, bytes metadata)` |
| `payInvoiceWithPermit` | `payInvoiceWithPermit(…payInvoice args…, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)` — one-tx pay with an EIP-2612 permit. Only where the deployed router supports it (feature-detect on `callWithPermit`) |
| `InvoicePaid` | `event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address token, uint256 amount, uint256 fee, bytes metadata)` |
