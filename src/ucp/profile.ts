/** Helpers for reading a UCP business profile (spec: overview "Profile Structure"). */

export interface ProfileEntity {
  name: string;
  kind: 'service' | 'capability' | 'payment_handler';
  version?: unknown;
  spec?: unknown;
  schema?: unknown;
  transport?: unknown;
  endpoint?: unknown;
  extends?: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function ucpOf(profile: unknown): Record<string, unknown> | null {
  return isObj(profile) && isObj(profile.ucp) ? profile.ucp : null;
}

function registry(ucp: Record<string, unknown>, key: string, kind: ProfileEntity['kind']): ProfileEntity[] {
  const reg = ucp[key];
  if (!isObj(reg)) return [];
  const out: ProfileEntity[] = [];
  for (const [name, entries] of Object.entries(reg)) {
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      if (isObj(e)) out.push({ name, kind, ...e });
    }
  }
  return out;
}

export function capabilities(profile: unknown): ProfileEntity[] {
  const u = ucpOf(profile);
  return u ? registry(u, 'capabilities', 'capability') : [];
}
export function services(profile: unknown): ProfileEntity[] {
  const u = ucpOf(profile);
  return u ? registry(u, 'services', 'service') : [];
}
export function paymentHandlers(profile: unknown): ProfileEntity[] {
  const u = ucpOf(profile);
  return u ? registry(u, 'payment_handlers', 'payment_handler') : [];
}

export function declaredVersion(profile: unknown): string | undefined {
  const v = ucpOf(profile)?.version;
  return typeof v === 'string' ? v : undefined;
}

export function hasCapability(profile: unknown, name: string): boolean {
  return capabilities(profile).some((c) => c.name === name);
}

/** First REST endpoint of the dev.ucp.shopping service (spec: overview "Endpoint Resolution"). */
export function restEndpoint(profile: unknown): string | undefined {
  const s = services(profile).find(
    (x) => x.name === 'dev.ucp.shopping' && x.transport === 'rest' && typeof x.endpoint === 'string',
  );
  return s ? String(s.endpoint).replace(/\/+$/, '') : undefined;
}

/**
 * Authority binding (spec 2026-08-25 overview "Authority Binding" → "Derivation algorithm"):
 * the `schema` URL must parse, be https, carry no userinfo, have a ≥2-label non-IP host; its
 * reversed host labels must equal the entity name or be a label-aligned prefix of it.
 */
export function authorityBinding(
  name: string,
  schemaUrl: string,
): { ok: boolean; reason: string; authorityPrefix?: string } {
  let url: URL;
  try {
    url = new URL(schemaUrl);
  } catch {
    return { ok: false, reason: 'schema URL does not parse' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'schema URL must use https' };
  if (url.username || url.password) return { ok: false, reason: 'schema URL must not contain userinfo' };
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host))
    return { ok: false, reason: 'IP-literal hosts are not valid authorities' };
  const labels = host.split('.');
  if (labels.length < 2) return { ok: false, reason: 'single-label hosts are not valid authorities' };
  const prefix = labels.reverse().join('.');
  const n = name.toLowerCase();
  if (n === prefix || n.startsWith(prefix + '.'))
    return { ok: true, reason: 'matches', authorityPrefix: prefix };
  return {
    ok: false,
    reason: `host ${host} reversed is "${prefix}", which is not a label-aligned prefix of "${name}"`,
    authorityPrefix: prefix,
  };
}
