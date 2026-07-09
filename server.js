require('dotenv').config();
const path = require('path');
const express = require('express');
const stripe = require('./lib/stripe');
const store = require('./lib/store');

const app = express();

// Serve the dashboard (static single-page UI in /public).
app.use(express.static(path.join(__dirname, 'public')));

// --- Courier onboarding -----------------------------------------------

// 1) Create a MINIMAL Custom account. Only country + business_type — no KYC yet.
// This is the "let them start earning today" step of deferred onboarding.
app.post('/couriers', express.json(), async (req, res) => {
  const { country = 'US' } = req.body;

  const account = await stripe.accounts.create({
    type: 'custom',
    country,
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true },
    },
    // No individual/name/dob/ssn/external_account here yet — deliberately deferred.
  });

  res.json({ courierId: account.id, transfersActive: false });
});

// 2) When the courier is ready (or is forced to by the cap), send them through
// full Stripe-hosted onboarding to collect the rest of their KYC requirements.
app.post('/couriers/:id/onboarding-link', express.json(), async (req, res) => {
  const { id } = req.params;
  const { returnUrl, refreshUrl } = req.body;

  const link = await stripe.accountLinks.create({
    account: id,
    type: 'account_onboarding',
    return_url: returnUrl || 'https://example.com/onboarding/return',
    refresh_url: refreshUrl || 'https://example.com/onboarding/refresh',
  });

  res.json({ url: link.url });
});

async function isTransfersActive(courierId) {
  const account = await stripe.accounts.retrieve(courierId);
  return account.capabilities && account.capabilities.transfers === 'active';
}

// Courier status — used by the dashboard to render onboarding + ledger state.
app.get('/couriers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const transfersActive = await isTransfersActive(id);
    res.json({
      courierId: id,
      transfersActive,
      released: store.hasBeenReleased(id),
      entries: store.getPending(id),
      totals: store.pendingTotals(id),
    });
  } catch (err) {
    res.status(404).json({ error: 'not_found', message: err.message });
  }
});

// Demo helper — inspect what's currently held for a courier.
app.get('/couriers/:id/pending', (req, res) => {
  const { id } = req.params;
  res.json({
    courierId: id,
    released: store.hasBeenReleased(id),
    entries: store.getPending(id),
    totals: store.pendingTotals(id),
  });
});

// --- Orders --------------------------------------------------------------

// 3) Customer places an order. Platform is always merchant of record (SCT).
// If the courier is already verified, we transfer their share immediately —
// this is just normal Separate Charges & Transfers at that point.
// If the courier is NOT yet verified, we charge the customer but HOLD the
// courier's share on the platform balance instead of transferring it.
app.post('/orders', express.json(), async (req, res) => {
  const { courierId, orderId, totalCents, courierShareCents } = req.body;
  if (!courierId || !orderId || !totalCents || !courierShareCents) {
    return res.status(400).json({ error: 'courierId, orderId, totalCents, courierShareCents are required' });
  }

  const verified = await isTransfersActive(courierId);

  if (!verified) {
    const check = store.canHoldAnotherOrder(courierId);
    if (!check.allowed) {
      return res.status(402).json({
        error: 'onboarding_required',
        message: `Cannot hold another order for this courier: ${check.reason}`,
        onboardingRequired: true,
      });
    }
  }

  const transferGroup = `order_${orderId}`;

  // Platform-account charge — never uses on_behalf_of / Stripe-Account header.
  const paymentIntent = await stripe.paymentIntents.create({
    amount: totalCents,
    currency: 'usd',
    payment_method: 'pm_card_visa', // test-mode token for the live demo
    confirm: true,
    transfer_group: transferGroup,
    metadata: { courierId, courierShareCents: String(courierShareCents), orderId },
  });

  if (paymentIntent.status !== 'succeeded') {
    return res.status(402).json({ error: 'payment_failed', status: paymentIntent.status });
  }

  const chargeId = paymentIntent.latest_charge;

  if (verified) {
    // Courier already onboarded — pay them out right away.
    const transfer = await stripe.transfers.create({
      amount: courierShareCents,
      currency: 'usd',
      destination: courierId,
      transfer_group: transferGroup,
      source_transaction: chargeId,
    });
    return res.json({ status: 'paid_out_immediately', paymentIntentId: paymentIntent.id, transferId: transfer.id });
  }

  // Courier not verified yet — hold their share on the platform.
  store.addPending(courierId, {
    orderId,
    chargeId,
    transferGroup,
    amountCents: courierShareCents,
  });

  res.json({
    status: 'held_pending_onboarding',
    paymentIntentId: paymentIntent.id,
    pending: store.pendingTotals(courierId),
  });
});

// --- Shared release logic -----------------------------------------------

// Pay out every held order for a newly-verified courier in one pass.
// Called from both the Stripe webhook (real flow) and the /simulate-verified
// dev endpoint (mock / rehearsal flow).
async function releaseHeldOrders(courierId) {
  if (store.hasBeenReleased(courierId)) return { released: 0, transfers: [] };

  const entries = store.getPending(courierId);
  if (entries.length === 0) {
    store.clearPending(courierId); // mark verified so future orders pay out immediately
    return { released: 0, transfers: [] };
  }

  console.log(`Releasing ${entries.length} held order(s) for ${courierId}`);

  // NOTE: in production, delay this 7-14 days past the courier's onboarding
  // date (via a job queue) to stay inside the dispute window on the orders
  // being released — not implemented in this demo, which releases immediately
  // for clarity.
  const transfers = [];
  for (const entry of entries) {
    const transfer = await stripe.transfers.create({
      amount: entry.amountCents,
      currency: 'usd',
      destination: courierId,
      transfer_group: entry.transferGroup,
      source_transaction: entry.chargeId,
    });
    transfers.push(transfer.id);
  }
  store.clearPending(courierId);
  return { released: entries.length, transfers };
}

// --- Webhook: release held earnings once the courier finishes onboarding -

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const transfersActive = account.capabilities && account.capabilities.transfers === 'active';
    if (transfersActive) {
      await releaseHeldOrders(account.id);
    }
  }

  res.json({ received: true });
});

// --- Dashboard config + simulation helpers ------------------------------

// Expose runtime config so the UI can render caps and indicate whether it is
// talking to real Stripe or the in-memory mock.
app.get('/config', (req, res) => {
  res.json({
    mock: Boolean(stripe.__isMock),
    caps: store.getCaps(),
  });
});

// Simulate a courier completing onboarding without waiting on the Stripe CLI
// webhook. In mock mode this flips the mock account's `transfers` capability to
// `active`; in both modes it then runs the same release logic the webhook uses.
// Intended for demos/rehearsal only.
app.post('/couriers/:id/simulate-verified', express.json(), async (req, res) => {
  const { id } = req.params;
  if (stripe.__isMock && typeof stripe.__setVerified === 'function') {
    stripe.__setVerified(id);
  }
  try {
    const active = await isTransfersActive(id);
    if (!active) {
      return res.status(409).json({
        error: 'not_active',
        message:
          'Transfers capability is not active for this courier. With real Stripe, complete Stripe-hosted onboarding so the account.updated webhook fires.',
      });
    }
    const result = await releaseHeldOrders(id);
    res.json({ status: 'verified', ...result });
  } catch (err) {
    res.status(404).json({ error: 'not_found', message: err.message });
  }
});

// Bind to the port the platform/preview provides (PORT), falling back to 3000
// for local dev. Listen on 0.0.0.0 so the preview proxy can reach it.
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () =>
  console.log(`Deferred onboarding demo listening on :${port}`)
);
