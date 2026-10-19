/**
 * Money helpers. UCP amounts are integers in ISO 4217 minor units (schemas/ucp/<v>/common/types/amount.json).
 * schema.org prices are decimal strings in major units. We convert decimals to minor units with
 * string arithmetic (never floats) and compare exactly — the spec defines no rounding tolerance.
 */

/** ISO 4217 currencies whose minor-unit exponent is not 2. */
const EXPONENTS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Validate a schema.org price string: positive decimal, dot separator, no more fraction digits
 * than the currency allows. Returns a reason string when invalid.
 */
export function priceFormatProblem(price: string | undefined, currency: string | undefined): string | null {
  if (price === undefined) return 'no price';
  const m = DECIMAL_RE.exec(price.trim());
  if (!m)
    return `"${price.slice(0, 40)}" is not a plain decimal number (use digits and a dot, no currency symbols or commas)`;
  const exp = currency ? currencyExponent(currency) : 2;
  const frac = m[2] ?? '';
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp)))
    return `"${price}" has more than ${exp} decimal places for ${currency ?? 'the currency'}`;
  if (/^0*$/.test(m[1]!) && /^0*$/.test(frac)) return `"${price}" is not positive`;
  return null;
}

/** Convert a decimal major-unit price string to integer minor units. Null if not exactly representable. */
export function decimalToMinor(price: string, currency: string): number | null {
  const m = DECIMAL_RE.exec(price.trim());
  if (!m) return null;
  const exp = currencyExponent(currency);
  let frac = m[2] ?? '';
  if (frac.length > exp) {
    if (/[1-9]/.test(frac.slice(exp))) return null;
    frac = frac.slice(0, exp);
  }
  const digits = (m[1]! + frac.padEnd(exp, '0')).replace(/^0+(?=\d)/, '');
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

export function formatMinor(amount: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return `${amount} ${currency}`;
  const s = String(Math.abs(amount)).padStart(exp + 1, '0');
  return `${amount < 0 ? '-' : ''}${s.slice(0, -exp)}.${s.slice(-exp)} ${currency}`;
}
