import { LATENCY } from '../../config/weights';
import type { CheckDefinition, ScanContext } from '../../scan/types';
import { authorityBinding, capabilities, declaredVersion, paymentHandlers, restEndpoint, services } from '../../ucp/profile';
import { formatAjvError, validate, validationVersion } from '../../ucp/validators';
import { classifyVersion, KNOWN_RELEASES, LATEST_VERSION, PREVIOUS_VERSION, VERSION_RE } from '../../ucp/versions';
import { describeFetch, isObj, result, summarize, truncate } from '../helpers';

const PROFILE_PATH = '/.well-known/ucp';
const MAX_STORED_PROFILE = 128 * 1024;

/** Discovery phase data gathering: fetch the profile exactly once. */
export async function prepareDiscovery(ctx: ScanContext): Promise<void> {
  const url = ctx.url + PROFILE_PATH;
  // Spec (overview "Profile Requirements → Hosting/Fetching"): no redirects; bound body size.
  const r = await ctx.http.fetch(url, { accept: 'application/json', maxRedirects: 0, maxBytes: 1_000_000, timeoutMs: 8000 });
  const state: NonNullable<ScanContext['state']['profile']> = { fetch: summarize(r) };
  if (r.bodyText !== undefined && r.status >= 200 && r.status < 300) {
    state.bodySnippet = truncate(r.bodyText.trim(), 300);
    try {
      const parsed: unknown = JSON.parse(r.bodyText);
      if (r.bodyText.length <= MAX_STORED_PROFILE) state.json = parsed;
      else state.parseError = `profile is ${r.bodyText.length} bytes; CartProbe analyses profiles up to ${MAX_STORED_PROFILE} bytes`;
      ctx.state.profileVersion = declaredVersion(parsed);
      ctx.state.restEndpoint = restEndpoint(parsed);
    } catch (e) {
      state.parseError = truncate(String((e as Error).message), 200);
    }
    if (ctx.capture) await ctx.capture('profile.json', r.bodyText);
  }
  ctx.state.profile = state;
  ctx.state.validationVersion = validationVersion(ctx.state.profileVersion);
}

const profileUrl = (ctx: ScanContext) => ctx.url + PROFILE_PATH;

export const discoveryChecks: CheckDefinition[] = [
  {
    id: 'discovery.profile_reachable',
    title: 'UCP profile is reachable',
    category: 'discovery',
    severity: 'critical',
    phase: 'discovery',
    why: 'Agents start every interaction by fetching /.well-known/ucp; without it they cannot see your store as UCP-enabled.',
    async run(ctx) {
      const f = ctx.state.profile?.fetch;
      const url = profileUrl(ctx);
      if (!f) return result('error', 'The profile was not fetched.');
      if (f.error) {
        return result('fail', `We could not fetch your UCP profile (${f.error.kind.replace(/_/g, ' ')}).`, [
          { label: 'Request', url, expected: 'HTTP 200 with a JSON profile', found: describeFetch(f) },
        ]);
      }
      if (f.status >= 300 && f.status < 400) {
        return result('fail', 'Your UCP profile URL redirects. The spec says profile endpoints must not redirect and agents must not follow redirects.', [
          { label: 'Redirect', url, expected: 'HTTP 200 served directly at this URL', found: `HTTP ${f.status} → ${f.redirects[0]?.to ?? f.headers.location ?? '(no Location)'}` },
        ]);
      }
      if (f.status < 200 || f.status >= 300) {
        return result('fail', `Your UCP profile returned HTTP ${f.status}.`, [{ label: 'Request', url, expected: 'HTTP 200', found: describeFetch(f) }]);
      }
      return result('pass', 'Your UCP profile is served over HTTPS at /.well-known/ucp.', [{ label: 'Request', url, found: describeFetch(f) }]);
    },
  },
  {
    id: 'discovery.profile_content_type',
    title: 'Profile is served as JSON',
    category: 'discovery',
    severity: 'low',
    phase: 'discovery',
    dependsOn: ['discovery.profile_reachable'],
    why: 'Strict clients check the Content-Type header before parsing.',
    async run(ctx) {
      const p = ctx.state.profile!;
      const ct = p.fetch.contentType ?? '(none)';
      const ev = [{ label: 'Content-Type header', url: profileUrl(ctx), expected: 'application/json', found: ct }];
      if (/(^|\/|\+)json\b/i.test(ct)) return result('pass', 'The profile is served with a JSON content type.', ev);
      if (!p.parseError && p.json !== undefined) return result('warn', `The profile parses as JSON but is served as ${ct}.`, ev);
      return result('fail', `The profile is served as ${ct} and is not JSON.`, ev);
    },
  },
  {
    id: 'discovery.profile_parses',
    title: 'Profile is valid JSON',
    category: 'discovery',
    severity: 'critical',
    phase: 'discovery',
    dependsOn: ['discovery.profile_reachable'],
    why: 'An agent cannot read a profile that is not a JSON object.',
    async run(ctx) {
      const p = ctx.state.profile!;
      if (p.parseError) {
        return result('fail', 'The profile body is not valid JSON.', [
          { label: 'Parse error', url: profileUrl(ctx), expected: 'A JSON object', found: p.parseError },
          { label: 'Start of body', found: p.bodySnippet ?? '' },
        ]);
      }
      if (!isObj(p.json)) {
        return result('fail', 'The profile is JSON but not an object.', [{ label: 'Body', url: profileUrl(ctx), expected: 'A JSON object with a "ucp" member', found: p.bodySnippet ?? '' }]);
      }
      return result('pass', 'The profile is a valid JSON object.');
    },
  },
  {
    id: 'discovery.profile_schema_valid',
    title: 'Profile matches the UCP schema',
    category: 'discovery',
    severity: 'high',
    phase: 'discovery',
    dependsOn: ['discovery.profile_parses'],
    why: 'Agents validate profiles against the published schema and may ignore a profile that fails.',
    async run(ctx) {
      const v = validationVersion(ctx.state.profileVersion);
      const out = validate('profile', ctx.state.profile!.json, v);
      const declared = ctx.state.profileVersion ?? '(none)';
      const note = declared === v ? `version ${v}` : `latest vendored version ${v} (profile declares ${declared})`;
      if (out.valid) return result('pass', `The profile validates against the UCP ${note} business profile schema.`, [], { version: v });
      const errs = out.errors.slice(0, 20);
      return result(
        'fail',
        `The profile has ${out.errors.length} schema error${out.errors.length === 1 ? '' : 's'} against the UCP ${note} schema.`,
        errs.map((e) => ({ label: 'Schema error', expected: e.schemaPath, found: formatAjvError(e) })),
        { version: v, errorCount: out.errors.length },
      );
    },
  },
  {
    id: 'discovery.version_current',
    title: 'Profile uses the current UCP version',
    category: 'discovery',
    severity: 'medium',
    phase: 'discovery',
    dependsOn: ['discovery.profile_parses'],
    why: 'Agents prefer the most recent protocol version; older versions miss newer features and may stop being supported.',
    async run(ctx) {
      const v = ctx.state.profileVersion;
      const ev = [{ label: 'ucp.version', url: profileUrl(ctx), expected: LATEST_VERSION, found: v ?? '(missing)' }];
      const c = classifyVersion(v);
      if (c === 'latest') return result('pass', `Your UCP profile declares version ${v}, the latest release.`, ev);
      if (c === 'previous') return result('warn', `Your UCP profile declares version ${v}; the latest is ${LATEST_VERSION}. Agents may not use newer features with your store.`, ev);
      if (c === 'older') return result('fail', `Your UCP profile declares version ${v}, which is older than the previous release (${PREVIOUS_VERSION}). The latest is ${LATEST_VERSION}.`, ev);
      if (typeof v === 'string' && VERSION_RE.test(v) && v > LATEST_VERSION) {
        return result('warn', `Your profile declares ${v}, newer than the latest release CartProbe knows (${LATEST_VERSION}). We will update our checks; nothing to fix on your side if this is a real release.`, ev);
      }
      return result('fail', `Your profile declares ${v === undefined ? 'no version' : `"${truncate(String(v), 40)}"`}, which is not a published UCP release (${KNOWN_RELEASES.join(', ')}).`, ev);
    },
  },
  {
    id: 'discovery.capabilities_declared',
    title: 'Shopping capabilities are declared',
    category: 'discovery',
    severity: 'high',
    phase: 'discovery',
    dependsOn: ['discovery.profile_parses'],
    why: 'Agents only use the capabilities your profile lists; with none, there is nothing for them to call.',
    async run(ctx) {
      const caps = capabilities(ctx.state.profile!.json);
      const names = [...new Set(caps.map((c) => c.name))];
      const shopping = names.filter((n) => /\.shopping\./.test(n));
      const ev = [{ label: 'Declared capabilities', url: profileUrl(ctx), found: names.length ? truncate(names.join(', ')) : '(none)' }];
      if (shopping.length === 0) return result('fail', 'Your profile declares no shopping capabilities (such as dev.ucp.shopping.checkout or dev.ucp.shopping.catalog.search).', ev);
      return result('pass', `Your profile declares ${shopping.length} shopping capabilit${shopping.length === 1 ? 'y' : 'ies'}: ${truncate(shopping.join(', '), 300)}.`, ev, { capabilities: names });
    },
  },
  {
    id: 'discovery.capability_versions_valid',
    title: 'Capability versions are valid',
    category: 'discovery',
    severity: 'medium',
    phase: 'discovery',
    dependsOn: ['discovery.capabilities_declared'],
    why: 'Agents negotiate capabilities by exact version match; malformed or unknown versions will not match.',
    async run(ctx) {
      const caps = capabilities(ctx.state.profile!.json);
      const bad: { name: string; version: string }[] = [];
      const unknown: { name: string; version: string }[] = [];
      for (const c of caps) {
        const v = typeof c.version === 'string' ? c.version : String(c.version ?? '(missing)');
        if (!VERSION_RE.test(v)) bad.push({ name: c.name, version: v });
        // dev.ucp.* entries carry the release date; third-party versions are author-controlled (spec "Capability Versions").
        else if (c.name.startsWith('dev.ucp.') && !(KNOWN_RELEASES as readonly string[]).includes(v)) unknown.push({ name: c.name, version: v });
      }
      const ev = [...bad, ...unknown].slice(0, 20).map((x) => ({ label: x.name, expected: 'YYYY-MM-DD matching a UCP release', found: truncate(x.version, 60) }));
      if (bad.length) return result('fail', `${bad.length} capability version${bad.length === 1 ? ' is' : 's are'} not in YYYY-MM-DD format.`, ev);
      if (unknown.length) return result('warn', `${unknown.length} dev.ucp capability version${unknown.length === 1 ? ' does' : 's do'} not match a published UCP release.`, ev);
      return result('pass', `All ${caps.length} capability versions are well-formed.`);
    },
  },
  {
    id: 'discovery.namespace_host_rule',
    title: 'Schema URLs match capability namespaces',
    category: 'discovery',
    severity: 'high',
    phase: 'discovery',
    dependsOn: ['discovery.capabilities_declared'],
    why: 'Agents must reject (treat as absent) any capability whose schema URL host does not match its reverse-domain name.',
    async run(ctx) {
      const json = ctx.state.profile!.json;
      const entities = [...capabilities(json), ...services(json), ...paymentHandlers(json)];
      const failures: { name: string; schema: string; reason: string }[] = [];
      const specProblems: { name: string; spec: string }[] = [];
      let checked = 0;
      for (const e of entities) {
        if (typeof e.schema === 'string') {
          checked++;
          const b = authorityBinding(e.name, e.schema);
          if (!b.ok) failures.push({ name: e.name, schema: e.schema, reason: b.reason });
        } else if (e.kind === 'capability') {
          failures.push({ name: e.name, schema: '(missing)', reason: 'capabilities must declare a schema URL' });
        }
        if (typeof e.spec === 'string' && !/^https:\/\//i.test(e.spec)) specProblems.push({ name: e.name, spec: e.spec });
      }
      const ev = failures.slice(0, 20).map((f) => ({ label: f.name, url: f.schema.startsWith('http') ? f.schema : undefined, expected: 'schema host whose reversed labels prefix the name (e.g. ucp.dev for dev.ucp.*)', found: truncate(f.reason, 200) }));
      if (failures.length) return result('fail', `${failures.length} declared entit${failures.length === 1 ? 'y has' : 'ies have'} a schema URL that does not match its namespace. Agents will ignore ${failures.length === 1 ? 'it' : 'them'}.`, ev);
      if (specProblems.length) {
        return result('warn', 'Schema URLs match their namespaces, but some spec URLs are not https.', specProblems.slice(0, 20).map((s) => ({ label: s.name, expected: 'https URL', found: truncate(s.spec, 200) })));
      }
      return result('pass', `All ${checked} schema URLs are served from hosts matching their namespace.`);
    },
  },
  {
    id: 'discovery.endpoints_reachable',
    title: 'Declared service endpoints respond',
    category: 'discovery',
    severity: 'high',
    phase: 'discovery',
    dependsOn: ['discovery.profile_parses'],
    why: 'Agents call the endpoints in your profile; a dead endpoint means every request fails.',
    async run(ctx) {
      const eps = services(ctx.state.profile!.json)
        .filter((s) => typeof s.endpoint === 'string' && ['rest', 'mcp', 'a2a'].includes(String(s.transport)))
        .slice(0, 5);
      if (eps.length === 0) return result('skip', 'Your profile declares no REST, MCP or A2A endpoints to check.');
      const bad: string[] = [];
      const ev = [];
      for (const s of eps) {
        // A plain GET has no side effects. 2xx–4xx means the server is there; 5xx/timeouts mean it is not.
        const r = await ctx.http.fetch(String(s.endpoint), { method: 'GET', timeoutMs: 6000, maxBytes: 64_000, maxRedirects: 3 });
        const healthy = !r.error && r.status >= 200 && r.status < 500;
        if (!healthy) bad.push(String(s.endpoint));
        ev.push({ label: `${s.name} (${String(s.transport)})`, url: String(s.endpoint), expected: 'any HTTP response below 500', found: describeFetch(summarize(r)) });
      }
      if (bad.length) return result('fail', `${bad.length} of ${eps.length} declared endpoints did not respond correctly.`, ev);
      return result('pass', `All ${eps.length} declared endpoints respond.`, ev);
    },
  },
  {
    id: 'discovery.profile_latency',
    title: 'Profile responds quickly',
    category: 'discovery',
    severity: 'low',
    phase: 'discovery',
    dependsOn: ['discovery.profile_reachable'],
    why: 'Agents work under tight time budgets; slow discovery delays or drops your store.',
    async run(ctx) {
      const t = ctx.state.profile!.fetch.ttfbMs;
      const ev = [{ label: 'Time to first byte', url: profileUrl(ctx), expected: `< ${LATENCY.profileTtfb.pass} ms`, found: `${t} ms` }];
      if (t < LATENCY.profileTtfb.pass) return result('pass', `The profile responded in ${t} ms.`, ev);
      if (t < LATENCY.profileTtfb.warn) return result('warn', `The profile took ${t} ms to respond.`, ev);
      return result('fail', `The profile took ${t} ms to respond.`, ev);
    },
  },
  {
    id: 'discovery.profile_cache_headers',
    title: 'Profile is cacheable',
    category: 'discovery',
    severity: 'medium',
    phase: 'discovery',
    dependsOn: ['discovery.profile_reachable'],
    why: 'The spec requires a public Cache-Control of at least 60 seconds so agents can cache your profile.',
    async run(ctx) {
      const h = ctx.state.profile!.fetch.headers;
      const cc = (h['cache-control'] ?? '').toLowerCase();
      const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/.exec(cc)?.[1] ?? NaN);
      const ev = [{ label: 'Cache-Control', url: profileUrl(ctx), expected: 'public, max-age=60 or more (no private/no-store/no-cache)', found: h['cache-control'] ?? '(missing)' }];
      const forbidden = /\b(private|no-store|no-cache)\b/.test(cc);
      if (!cc || !/\bpublic\b/.test(cc) || !(maxAge >= 60) || forbidden) {
        return result('fail', 'Your profile does not send the Cache-Control header the spec requires (public, max-age of at least 60 seconds).', ev);
      }
      if (!h.etag && !h['last-modified']) {
        return result('warn', 'Your profile is cacheable but sends no ETag or Last-Modified header, so agents cannot revalidate it cheaply.', [...ev, { label: 'Validator', expected: 'ETag or Last-Modified', found: '(missing)' }]);
      }
      return result('pass', 'Your profile sends cache headers that meet the spec.', ev);
    },
  },
  {
    id: 'discovery.mcp_transport_declared',
    title: 'Additional transports (MCP / A2A)',
    category: 'discovery',
    severity: 'info',
    phase: 'discovery',
    dependsOn: ['discovery.profile_parses'],
    why: 'Some agents prefer MCP or A2A; offering them widens where your store can appear.',
    async run(ctx) {
      const t = [...new Set(services(ctx.state.profile!.json).map((s) => String(s.transport)))];
      const extra = t.filter((x) => x === 'mcp' || x === 'a2a');
      if (extra.length) return result('pass', `Your profile also offers: ${extra.join(', ')}.`, [{ label: 'Transports', found: t.join(', ') }]);
      return result('skip', `Informational: your profile declares ${t.length ? t.join(', ') : 'no'} transport${t.length === 1 ? '' : 's'}; no MCP or A2A binding.`);
    },
  },
];
