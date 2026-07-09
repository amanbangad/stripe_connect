// Dashboard client for the deferred-onboarding demo.
// Talks to the same Express endpoints used in the CLI walkthrough.

const $ = (id) => document.getElementById(id);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

const state = {
  courier: null, // { id, transfersActive, released, entries, totals }
  caps: { maxHeldOrders: 3, maxHeldCents: 5000 },
  mock: false,
  orderSeq: 1,
};

// --- helpers ------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `${res.status} ${res.statusText}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function log(message, type = 'info') {
  const li = document.createElement('li');
  li.className = `log__item log__item--${type}`;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  const span = document.createElement('span');
  span.textContent = message;
  li.append(time, span);
  const list = $('log');
  list.prepend(li);
}

function flashFlow(kind) {
  const held = $('node-held');
  const courier = $('node-courier');
  const charge = $('arrow-charge');
  const hold = $('arrow-hold');
  const payout = $('arrow-payout');

  [held, courier].forEach((n) => n.classList.remove('node--flash-hold', 'node--flash-pay'));
  [charge, hold, payout].forEach((a) =>
    a.classList.remove('arrow--active', 'arrow--hold', 'arrow--pay')
  );

  charge.classList.add('arrow--active');
  if (kind === 'hold') {
    hold.classList.add('arrow--active', 'arrow--hold');
    held.classList.add('node--flash-hold');
  } else if (kind === 'pay') {
    payout.classList.add('arrow--active', 'arrow--pay');
    courier.classList.add('node--flash-pay');
  }

  window.clearTimeout(flashFlow._t);
  flashFlow._t = window.setTimeout(() => {
    [held, courier].forEach((n) => n.classList.remove('node--flash-hold', 'node--flash-pay'));
    [charge, hold, payout].forEach((a) =>
      a.classList.remove('arrow--active', 'arrow--hold', 'arrow--pay')
    );
  }, 2200);
}

// --- rendering ----------------------------------------------------------

function render() {
  const c = state.courier;
  const hasCourier = Boolean(c);

  $('courier-empty').classList.toggle('hidden', hasCourier);
  $('courier-card').classList.toggle('hidden', !hasCourier);
  $('btn-order').disabled = !hasCourier;
  $('order-form').querySelector('.form__note').style.display = hasCourier ? 'none' : '';

  if (!hasCourier) {
    renderLedger(null);
    return;
  }

  $('courier-id').textContent = c.id;

  const verified = c.transfersActive;
  const statusEl = $('courier-status');
  statusEl.textContent = verified ? 'Verified' : 'Unverified';
  statusEl.className = `pill ${verified ? 'pill--success' : 'pill--warn'}`;

  // cap meter
  const { count, amountCents } = c.totals;
  const { maxHeldOrders, maxHeldCents } = state.caps;
  const countRatio = maxHeldOrders ? count / maxHeldOrders : 0;
  const amountRatio = maxHeldCents ? amountCents / maxHeldCents : 0;
  const ratio = Math.min(1, Math.max(countRatio, amountRatio));

  $('cap-count').textContent = `${count} / ${maxHeldOrders} orders`;
  $('cap-amount').textContent = `${usd(amountCents)} held`;
  $('cap-limit').textContent = `cap ${usd(maxHeldCents)}`;
  const fill = $('cap-fill');
  fill.style.width = `${ratio * 100}%`;
  fill.classList.toggle('cap__fill--full', ratio >= 1);

  // verified couriers no longer accrue held exposure
  const capWrap = fill.closest('.cap');
  capWrap.style.opacity = verified ? 0.45 : 1;

  $('btn-verify').disabled = verified;
  $('btn-verify').textContent = verified ? 'Verified' : 'Simulate verified';

  renderLedger(c);
}

function renderLedger(c) {
  const body = $('ledger-body');
  body.innerHTML = '';

  const entries = c ? c.entries : [];
  const totals = c ? c.totals : { count: 0, amountCents: 0 };

  $('total-count').textContent = totals.count;
  $('total-amount').textContent = usd(totals.amountCents);
  $('total-status').textContent = !c ? '—' : c.released ? 'released' : totals.count ? 'holding' : 'idle';

  if (!entries.length) {
    const tr = document.createElement('tr');
    tr.className = 'table__empty';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = c && c.released ? 'All held orders released.' : 'No held orders.';
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const e of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.orderId}</td>
      <td>${e.chargeId}</td>
      <td>${e.transferGroup}</td>
      <td class="num">${usd(e.amountCents)}</td>
    `;
    body.append(tr);
  }
}

async function refreshCourier() {
  if (!state.courier) return;
  try {
    const data = await api('GET', `/couriers/${state.courier.id}`);
    // Normalize: the API returns `courierId`, but state uses `id`.
    state.courier = { id: data.courierId, ...data };
    render();
  } catch (err) {
    log(`Could not refresh courier: ${err.message}`, 'error');
  }
}

// --- actions ------------------------------------------------------------

async function createCourier() {
  try {
    const data = await api('POST', '/couriers', { country: 'US' });
    state.courier = {
      id: data.courierId,
      transfersActive: false,
      released: false,
      entries: [],
      totals: { count: 0, amountCents: 0 },
    };
    state.orderSeq = 1;
    $('order-id').value = 'o1';
    log(`Created Custom account ${data.courierId} (minimal — no KYC yet).`, 'info');
    render();
  } catch (err) {
    log(`Create courier failed: ${err.message}`, 'error');
  }
}

async function placeOrder(evt) {
  evt.preventDefault();
  if (!state.courier) return;

  const orderId = $('order-id').value.trim() || `o${state.orderSeq}`;
  const totalCents = Math.round(parseFloat($('order-total').value) * 100);
  const courierShareCents = Math.round(parseFloat($('order-share').value) * 100);

  if (!totalCents || !courierShareCents) {
    log('Order total and courier share are required.', 'error');
    return;
  }

  $('btn-order').disabled = true;
  try {
    const data = await api('POST', '/orders', {
      courierId: state.courier.id,
      orderId,
      totalCents,
      courierShareCents,
    });

    if (data.status === 'held_pending_onboarding') {
      flashFlow('hold');
      log(
        `Order ${orderId}: charged ${usd(totalCents)}, held ${usd(courierShareCents)} on platform (courier unverified).`,
        'hold'
      );
    } else if (data.status === 'paid_out_immediately') {
      flashFlow('pay');
      log(
        `Order ${orderId}: charged ${usd(totalCents)}, transferred ${usd(courierShareCents)} to courier immediately.`,
        'pay'
      );
    }

    // advance order id
    state.orderSeq += 1;
    $('order-id').value = `o${state.orderSeq}`;
    await refreshCourier();
  } catch (err) {
    if (err.status === 402 && err.data && err.data.onboardingRequired) {
      log(`Order ${orderId} rejected — risk cap reached. ${err.data.message}`, 'error');
    } else {
      log(`Order ${orderId} failed: ${err.message}`, 'error');
    }
  } finally {
    $('btn-order').disabled = !state.courier;
  }
}

async function getOnboardingLink() {
  if (!state.courier) return;
  try {
    const data = await api('POST', `/couriers/${state.courier.id}/onboarding-link`, {});
    log(`Onboarding link created — opening Stripe-hosted onboarding.`, 'info');
    window.open(data.url, '_blank', 'noopener');
  } catch (err) {
    log(`Onboarding link failed: ${err.message}`, 'error');
  }
}

async function simulateVerified() {
  if (!state.courier) return;
  $('btn-verify').disabled = true;
  try {
    const data = await api('POST', `/couriers/${state.courier.id}/simulate-verified`, {});
    if (data.released > 0) {
      flashFlow('pay');
      log(`Courier verified — released ${data.released} held order(s) to the courier.`, 'pay');
    } else {
      log(`Courier verified — no held orders to release. Future orders pay out immediately.`, 'pay');
    }
    await refreshCourier();
  } catch (err) {
    log(`Verification failed: ${err.message}`, 'error');
    $('btn-verify').disabled = false;
  }
}

// --- init ---------------------------------------------------------------

async function init() {
  $('btn-create').addEventListener('click', createCourier);
  $('btn-reset').addEventListener('click', createCourier);
  $('btn-onboard').addEventListener('click', getOnboardingLink);
  $('btn-verify').addEventListener('click', simulateVerified);
  $('order-form').addEventListener('submit', placeOrder);

  try {
    const cfg = await api('GET', '/config');
    state.caps = cfg.caps;
    state.mock = cfg.mock;

    const badge = $('mode-badge');
    badge.textContent = cfg.mock ? 'MOCK MODE' : 'LIVE STRIPE';
    badge.className = `badge ${cfg.mock ? 'badge--mock' : 'badge--live'}`;

    $('caps-badge').textContent = `cap: ${cfg.caps.maxHeldOrders} orders / ${usd(cfg.caps.maxHeldCents)}`;

    log(
      cfg.mock
        ? 'Running in mock mode (no STRIPE_SECRET_KEY). Flow is simulated in memory.'
        : 'Connected to live Stripe (test mode).',
      'info'
    );
  } catch (err) {
    log(`Could not load config: ${err.message}`, 'error');
  }

  render();
}

init();
