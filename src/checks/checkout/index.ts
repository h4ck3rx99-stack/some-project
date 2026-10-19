import type { CheckDefinition, ScanContext } from '../../scan/types';
import { hasCapability } from '../../ucp/profile';
import { formatAjvError, validate, validationVersion } from '../../ucp/validators';
import { ucpHeaders } from '../catalog';
import { describeFetch, isObj, result, skip, summarize } from '../helpers';

export const CHECKOUT_CAPABILITY = 'dev.ucp.shopping.checkout';

/** Test checkout endpoint must be https on the verified domain (or a subdomain of it). */
export function checkoutEndpointAllowed(endpoint: string, domain: string): boolean {
  try {
    const u = new URL(endpoint);
    const d = domain.toLowerCase().replace(/^www\./, '');
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function deepCheckoutAllowed(
  ctx: Pick<ScanContext, 'verifiedOwnership' | 'testModeConfirmed' | 'testCheckoutEndpoint' | 'domain'>,
): boolean {
  return !!(
    ctx.verifiedOwnership &&
    ctx.testModeConfirmed &&
    ctx.testCheckoutEndpoint &&
    checkoutEndpointAllowed(ctx.testCheckoutEndpoint, ctx.domain)
  );
}

/**
 * Deep checkout probe, verified stores in confirmed test mode ONLY:
 * create a session with one in-stock item, then cancel it immediately (spec: POST
 * /checkout-sessions, POST /checkout-sessions/{id}/cancel). No payment data is ever sent and
 * complete_checkout is never called.
 */
export async function prepareCheckout(ctx: ScanContext): Promise<void> {
  if (!deepCheckoutAllowed(ctx)) {
    ctx.state.checkout = { skippedReason: 'not_verified' };
    return;
  }
  const item = (ctx.state.catalog?.products ?? [])
    .flatMap((p) => p.variants)
    .find((v) => v.available === true && v.id);
  if (!item?.id) {
    ctx.state.checkout = { skippedReason: 'no_item' };
    return;
  }
  const base = ctx.testCheckoutEndpoint!.replace(/\/+$/, '');
  const create = await ctx.http.fetch(base + '/checkout-sessions', {
    method: 'POST',
    accept: 'application/json',
    headers: ucpHeaders(ctx, { 'idempotency-key': crypto.randomUUID() }),
    body: JSON.stringify({ line_items: [{ item: { id: item.id }, quantity: 1 }] }),
    maxRedirects: 0,
    timeoutMs: 10_000,
  });
  const state: NonNullable<ScanContext['state']['checkout']> = {
    createFetch: summarize(create),
    json: create.json,
    itemId: item.id,
  };
  const id = isObj(create.json) && typeof create.json.id === 'string' ? create.json.id : undefined;
  if (id) {
    state.sessionId = id;
    const cancel = await ctx.http.fetch(`${base}/checkout-sessions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      accept: 'application/json',
      headers: ucpHeaders(ctx, { 'idempotency-key': crypto.randomUUID() }),
      body: '{}',
      maxRedirects: 0,
      timeoutMs: 10_000,
    });
    state.cancelFetch = summarize(cancel);
    state.cancelJson = cancel.json;
  }
  ctx.state.checkout = state;
}

function deepSkip(ctx: ScanContext) {
  const r = ctx.state.checkout?.skippedReason;
  if (r === 'no_item')
    return skip('No in-stock item with an id was found in the catalog response to place in a test checkout.');
  return null;
}

function totalsProblems(json: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const totals = Array.isArray(json.totals) ? json.totals.filter(isObj) : [];
  if (!totals.length) return ['no totals array'];
  for (const [i, t] of totals.entries())
    if (!Number.isInteger(t.amount))
      problems.push(`totals[${i}].amount ${JSON.stringify(t.amount)} is not an integer`);
  const items = Array.isArray(json.line_items) ? json.line_items.filter(isObj) : [];
  items.forEach((li, i) => {
    (Array.isArray(li.totals) ? li.totals.filter(isObj) : []).forEach((t, j) => {
      if (!Number.isInteger(t.amount))
        problems.push(`line_items[${i}].totals[${j}].amount ${JSON.stringify(t.amount)} is not an integer`);
    });
  });
  const subtotals = totals.filter((t) => t.type === 'subtotal');
  const grand = totals.filter((t) => t.type === 'total');
  if (subtotals.length !== 1) problems.push(`expected exactly one subtotal entry, found ${subtotals.length}`);
  if (grand.length !== 1) problems.push(`expected exactly one total entry, found ${grand.length}`);
  if (grand.length === 1 && totals.every((t) => Number.isInteger(t.amount))) {
    // Spec (checkout "Totals → Verification"): sum of all non-total entries equals the total.
    const sum = totals.filter((t) => t.type !== 'total').reduce((a, t) => a + (t.amount as number), 0);
    if (sum !== grand[0]!.amount)
      problems.push(`entries sum to ${sum} but total is ${String(grand[0]!.amount)}`);
  }
  if (subtotals.length === 1 && Number.isInteger(subtotals[0]!.amount) && items.length) {
    const lineSub = items.reduce((a, li) => {
      const st = (Array.isArray(li.totals) ? li.totals.filter(isObj) : []).find((t) => t.type === 'subtotal');
      return a + (st && Number.isInteger(st.amount) ? (st.amount as number) : 0);
    }, 0);
    if (lineSub && lineSub !== subtotals[0]!.amount)
      problems.push(`line item subtotals sum to ${lineSub} but subtotal is ${String(subtotals[0]!.amount)}`);
  }
  return problems;
}

const checkoutWhy =
  'Agents only complete purchases on stores whose checkout sessions behave as the spec describes.';

export const checkoutChecks: CheckDefinition[] = [
  {
    id: 'checkout.capability_declared',
    title: 'Checkout capability is declared',
    category: 'checkout',
    severity: 'medium',
    phase: 'checkout',
    dependsOn: ['discovery.profile_parses'],
    why: 'Without dev.ucp.shopping.checkout, agents can recommend your products but cannot buy them.',
    async run(ctx) {
      const declared = hasCapability(ctx.state.profile?.json, CHECKOUT_CAPABILITY);
      const note = deepCheckoutAllowed(ctx)
        ? ''
        : ' (Informational: checkout is not scored until you verify ownership and set up test mode.)';
      if (declared) return result('pass', `Your profile declares ${CHECKOUT_CAPABILITY}.${note}`);
      return result(
        'fail',
        `Your profile does not declare ${CHECKOUT_CAPABILITY}, so agents cannot start a purchase.${note}`,
      );
    },
  },
  {
    id: 'checkout.session_create',
    title: 'Test checkout session can be created',
    category: 'checkout',
    severity: 'critical',
    phase: 'checkout',
    dependsOn: ['checkout.capability_declared'],
    requires: { verifiedOwnership: true },
    why: checkoutWhy,
    async run(ctx) {
      const s = deepSkip(ctx);
      if (s) return s;
      const c = ctx.state.checkout!;
      const f = c.createFetch!;
      const url = ctx.testCheckoutEndpoint!.replace(/\/+$/, '') + '/checkout-sessions';
      const ev = [
        {
          label: `POST /checkout-sessions (1 × ${c.itemId})`,
          url,
          expected: 'HTTP 200/201 with a checkout session',
          found: describeFetch(f),
        },
      ];
      if (f.error || f.status < 200 || f.status >= 300 || !isObj(c.json))
        return result('fail', 'Creating a test checkout session failed.', ev);
      const declared = isObj(c.json.ucp) ? c.json.ucp.version : undefined;
      const v = validationVersion(declared ?? ctx.state.profileVersion);
      const out = validate('checkout', c.json, v);
      if (!out.valid) {
        return result(
          'fail',
          `The checkout session response has ${out.errors.length} schema error(s) against UCP ${v}.`,
          [
            ...ev,
            ...out.errors
              .slice(0, 19)
              .map((e) => ({ label: 'Schema error', expected: e.schemaPath, found: formatAjvError(e) })),
          ],
        );
      }
      return result(
        'pass',
        `A test checkout session was created and validates against the UCP ${v} checkout schema.`,
        ev,
      );
    },
  },
  {
    id: 'checkout.session_totals_integer',
    title: 'Checkout totals are consistent integers',
    category: 'checkout',
    severity: 'high',
    phase: 'checkout',
    dependsOn: ['checkout.session_create'],
    requires: { verifiedOwnership: true },
    why: 'The spec says agents must not complete a checkout whose totals do not add up.',
    async run(ctx) {
      const problems = totalsProblems(ctx.state.checkout!.json as Record<string, unknown>);
      if (problems.length)
        return result(
          'fail',
          `The checkout totals have ${problems.length} problem(s).`,
          problems.slice(0, 10).map((p) => ({
            label: 'Totals',
            expected: 'integer minor units; non-total entries sum to the total',
            found: p,
          })),
        );
      return result('pass', 'Checkout totals are integers and add up exactly.');
    },
  },
  {
    id: 'checkout.session_cleanup',
    title: 'Test checkout session is cancelled',
    category: 'checkout',
    severity: 'medium',
    phase: 'checkout',
    dependsOn: ['checkout.session_create'],
    requires: { verifiedOwnership: true },
    why: 'Agents cancel abandoned sessions; the cancel operation must work so inventory is not held.',
    async run(ctx) {
      const c = ctx.state.checkout!;
      const f = c.cancelFetch;
      if (!f) return result('fail', 'The created session had no id, so it could not be cancelled.');
      const status = isObj(c.cancelJson) ? c.cancelJson.status : undefined;
      const ev = [
        {
          label: 'POST /checkout-sessions/{id}/cancel',
          url: f.url,
          expected: 'HTTP 200 with status "canceled"',
          found: `${describeFetch(f)}; status ${JSON.stringify(status) ?? '(none)'}`,
        },
      ];
      if (f.ok && status === 'canceled')
        return result('pass', 'The test checkout session was cancelled.', ev);
      return result('fail', 'Cancelling the test checkout session did not return status "canceled".', ev);
    },
  },
];
