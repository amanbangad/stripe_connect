// In-memory mock of the small slice of the Stripe SDK this demo uses.
// Activated automatically when STRIPE_SECRET_KEY is not set, so the dashboard
// is fully interactive in a preview / rehearsal environment without a live key.
// The real SDK is used verbatim whenever a key IS present (see lib/stripe.js),
// so nothing about the production code path changes.

let seq = 1000;
const id = (prefix) => `${prefix}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// courierId -> account object (mirrors the fields server.js reads)
const accounts = new Map();

function makeAccount(country, verified = false) {
  return {
    id: id('acct'),
    object: 'account',
    type: 'custom',
    country,
    business_type: 'individual',
    capabilities: { transfers: verified ? 'active' : 'inactive' },
  };
}

const mockStripe = {
  __isMock: true,

  // Test helper used by the /simulate-verified dev endpoint in mock mode.
  __setVerified(courierId) {
    const acct = accounts.get(courierId);
    if (acct) acct.capabilities.transfers = 'active';
    return acct;
  },

  accounts: {
    async create({ country = 'US' } = {}) {
      const acct = makeAccount(country, false);
      accounts.set(acct.id, acct);
      return acct;
    },
    async retrieve(courierId) {
      const acct = accounts.get(courierId);
      if (!acct) {
        const err = new Error(`No such account: ${courierId}`);
        err.statusCode = 404;
        throw err;
      }
      return acct;
    },
  },

  accountLinks: {
    async create({ account }) {
      // In mock mode there is no Stripe-hosted page; point back at the
      // dashboard's simulated onboarding view so the demo stays self-contained.
      return { url: `/onboarding.html?account=${encodeURIComponent(account)}` };
    },
  },

  paymentIntents: {
    async create({ amount, currency = 'usd', metadata = {} }) {
      const pi = id('pi');
      return {
        id: pi,
        object: 'payment_intent',
        amount,
        currency,
        status: 'succeeded',
        latest_charge: id('ch'),
        metadata,
      };
    },
  },

  transfers: {
    async create({ amount, currency = 'usd', destination, transfer_group, source_transaction }) {
      return {
        id: id('tr'),
        object: 'transfer',
        amount,
        currency,
        destination,
        transfer_group,
        source_transaction,
      };
    },
  },

  webhooks: {
    // Not used in mock mode (no signed events), but kept for API parity.
    constructEvent(body) {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
  },
};

module.exports = mockStripe;
