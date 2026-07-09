const Stripe = require('stripe');

// Use the real Stripe SDK when a secret key is configured (the production /
// live-demo path). Fall back to an in-memory mock when it's missing so the
// dashboard is still fully interactive in a preview or offline rehearsal.
let stripe;

if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });
} else {
  console.warn(
    '[stripe] STRIPE_SECRET_KEY not set — using in-memory mock Stripe. ' +
      'Set a test key in .env to exercise the real Stripe Connect flow.'
  );
  stripe = require('./mock-stripe');
}

module.exports = stripe;
