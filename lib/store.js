// In-memory ledger for demo purposes only.
// In production this is a real table: pending_earnings(id, courier_id, order_id,
// charge_id, transfer_group, amount_cents, released_at).

const pendingByCourier = new Map(); // courierId -> [ { orderId, chargeId, transferGroup, amountCents, createdAt } ]
const releasedAccounts = new Set(); // courierIds whose backlog has already been paid out

const MAX_HELD_ORDERS = parseInt(process.env.MAX_HELD_ORDERS_PER_COURIER || '3', 10);
const MAX_HELD_CENTS = parseInt(process.env.MAX_HELD_CENTS_PER_COURIER || '5000', 10);

function getPending(courierId) {
  return pendingByCourier.get(courierId) || [];
}

function pendingTotals(courierId) {
  const entries = getPending(courierId);
  return {
    count: entries.length,
    amountCents: entries.reduce((sum, e) => sum + e.amountCents, 0),
  };
}

// Returns { allowed: boolean, reason?: string } — call before creating a new held order.
function canHoldAnotherOrder(courierId) {
  if (releasedAccounts.has(courierId)) {
    // Already verified once; caller should be routing straight transfers now, not holding.
    return { allowed: true };
  }
  const { count, amountCents } = pendingTotals(courierId);
  if (count >= MAX_HELD_ORDERS) {
    return { allowed: false, reason: `courier has ${count} held orders (cap ${MAX_HELD_ORDERS}); must finish onboarding` };
  }
  if (amountCents >= MAX_HELD_CENTS) {
    return { allowed: false, reason: `courier has $${(amountCents / 100).toFixed(2)} held (cap $${(MAX_HELD_CENTS / 100).toFixed(2)}); must finish onboarding` };
  }
  return { allowed: true };
}

function addPending(courierId, entry) {
  const list = pendingByCourier.get(courierId) || [];
  list.push({ ...entry, createdAt: Date.now() });
  pendingByCourier.set(courierId, list);
}

function clearPending(courierId) {
  pendingByCourier.delete(courierId);
  releasedAccounts.add(courierId);
}

function hasBeenReleased(courierId) {
  return releasedAccounts.has(courierId);
}

// Expose the configured risk caps so the dashboard can visualize headroom.
function getCaps() {
  return { maxHeldOrders: MAX_HELD_ORDERS, maxHeldCents: MAX_HELD_CENTS };
}

module.exports = {
  getPending,
  pendingTotals,
  canHoldAnotherOrder,
  addPending,
  clearPending,
  hasBeenReleased,
  getCaps,
};
