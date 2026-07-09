# Deferred onboarding demo (Stripe Connect, Custom accounts)

Demonstrates the "let couriers start earning before finishing KYC" pattern discussed
in the SA tech screen prep, built on top of Separate Charges & Transfers.

- Platform is always merchant of record (charges live on the platform account).
- A courier's `Custom` account is created with minimal info so they can be
  assigned deliveries immediately.
- Orders for an unverified courier are charged normally, but the courier's
  share is *held* on the platform balance instead of transferred.
- A cap (`MAX_HELD_ORDERS_PER_COURIER` / `MAX_HELD_CENTS_PER_COURIER`) limits
  how much exposure the platform takes on before forcing the courier through
  full onboarding.
- Once the courier's `transfers` capability goes `active` (`account.updated`
  webhook), all held orders are paid out in one pass and future orders pay
  out immediately.

## Visual dashboard

A single-page dashboard (served from `/public` by the same Express server) is
available at `http://localhost:4242/` once the server is running. It walks
through the whole funds flow visually — create a courier, place held orders,
watch the risk cap trigger, verify the courier, and see held earnings release —
all against the real endpoints below.

If `STRIPE_SECRET_KEY` is **not** set, the server transparently falls back to an
in-memory mock Stripe (`lib/mock-stripe.js`) so the dashboard is fully
interactive for offline rehearsal; the badge in the top-right shows `MOCK MODE`
vs `LIVE STRIPE`. In mock mode the "Onboarding link" opens a simulated
onboarding page, and "Simulate verified" flips the courier's `transfers`
capability and runs the same release logic the webhook uses. With a real test
key everything hits real Stripe instead.

## Setup

```bash
npm install
cp .env.example .env
# fill in STRIPE_SECRET_KEY (test mode) — or leave unset to run in mock mode
```

In a separate terminal, forward webhooks and copy the printed signing secret
into `.env` as `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:4242/webhooks/stripe
```

Start the server:

```bash
npm start
```

## Live demo script

1. **Create an unverified courier**

```bash
curl -s -X POST localhost:4242/couriers | jq
# => { "courierId": "acct_...", "transfersActive": false }
```

2. **Place a held order** (courier isn't verified, so their $6 share is held)

```bash
curl -s -X POST localhost:4242/orders \
  -H 'Content-Type: application/json' \
  -d '{"courierId":"acct_XXX","orderId":"o1","totalCents":3000,"courierShareCents":600}' | jq
# => { "status": "held_pending_onboarding", ... }
```

Repeat with `orderId":"o2"` and `"o3"`. Check the ledger:

```bash
curl -s localhost:4242/couriers/acct_XXX/pending | jq
```

3. **Show the cap kicking in** — a 4th held order (past `MAX_HELD_ORDERS_PER_COURIER=3`)
   is rejected and tells the caller onboarding is required:

```bash
curl -s -X POST localhost:4242/orders \
  -H 'Content-Type: application/json' \
  -d '{"courierId":"acct_XXX","orderId":"o4","totalCents":3000,"courierShareCents":600}' | jq
# => 402 { "error": "onboarding_required", ... }
```

This is the point in a real app where you'd surface a "complete onboarding to
get paid" prompt — and it's a good moment to talk through the risk tradeoff
with the interviewer (platform is carrying the dispute risk on 3 unverified
orders at once).

4. **Send the courier through full onboarding**

```bash
curl -s -X POST localhost:4242/couriers/acct_XXX/onboarding-link \
  -H 'Content-Type: application/json' -d '{}' | jq
```

Open the returned `url`. In test mode, use Stripe's documented test values
(e.g. any US SSN, `address_full_match` for verified address, a Stripe test
bank account) to complete the form quickly on screen. When it finishes,
Stripe fires `account.updated` with `capabilities.transfers = "active"`.

5. **Watch the release happen** — your server log prints
   `Releasing 3 held order(s) for acct_XXX`, and the three `Transfer`s land.
   Confirm:

```bash
curl -s localhost:4242/couriers/acct_XXX/pending | jq
# => { "released": true, "entries": [], "totals": { "count": 0, "amountCents": 0 } }
```

6. **Place one more order** — now `transfersActive` is true, so it pays out
   immediately instead of being held:

```bash
curl -s -X POST localhost:4242/orders \
  -H 'Content-Type: application/json' \
  -d '{"courierId":"acct_XXX","orderId":"o5","totalCents":3000,"courierShareCents":600}' | jq
# => { "status": "paid_out_immediately", ... }
```

## Talking points for the interview

- **Why hold instead of reject the order**: forcing KYC before a courier's
  first delivery kills activation; this defers the friction until it's
  actually justified by earned money.
- **Where the risk sits**: while orders are held, the platform (not the
  courier) is exposed to chargebacks/disputes, since funds haven't left the
  platform balance yet — that's *lower* risk than paying an unverified
  party directly, not higher.
- **Production hardening not shown here**: a real job queue with a 7–14 day
  delay on the release (rather than releasing the instant `transfers`
  becomes active) to stay inside the dispute window; a persistent ledger
  instead of the in-memory `Map` in `lib/store.js`; idempotency keys on the
  `Transfer` calls; and reconciling `source_transaction` availability timing
  if the underlying charge hasn't settled yet.
- **Relationship to the base SCT flow**: nothing about the funds-flow
  mechanics changes — it's still `PaymentIntent` + `transfer_group` +
  separate `Transfer` calls. Deferred onboarding only changes *when* the
  transfer fires.
