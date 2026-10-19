/**
 * robots.txt parser and matcher (RFC 9309 semantics):
 *  - the group whose user-agent token is the longest case-insensitive match of our product token wins;
 *    otherwise the `*` group; groups with the same agent are merged
 *  - within a group, the longest matching rule path wins; on a tie, `allow` wins
 *  - `*` matches any sequence, `$` anchors the end
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, 500_000).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && current) {
      // An empty Disallow means "allow everything" and contributes no rule.
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return { groups, sitemaps };
}

/** Select the rules that apply to `userAgent` (product token, e.g. "CartProbeBot"). */
export function rulesFor(robots: ParsedRobots, userAgent: string): { rules: RobotsRule[]; agent: string | null } {
  const ua = userAgent.toLowerCase();
  let best = '';
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a !== '*' && ua.includes(a) && a.length > best.length) best = a;
    }
  }
  const target = best || '*';
  const rules = robots.groups.filter((g) => g.agents.includes(target)).flatMap((g) => g.rules);
  const anyMatch = robots.groups.some((g) => g.agents.includes(target));
  return { rules, agent: anyMatch ? target : null };
}

function patternToRegExp(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = anchored ? path.slice(0, -1) : path;
  const escaped = body
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

function normalisePath(p: string): string {
  // Compare in percent-encoded form so /caf%C3%A9 and /café match.
  try {
    return encodeURI(decodeURI(p));
  } catch {
    return p;
  }
}

export interface RobotsDecision {
  allowed: boolean;
  rule: RobotsRule | null;
  agent: string | null;
}

/** Decide whether `pathWithQuery` (e.g. "/product/x?y=1") may be fetched by `userAgent`. */
export function isAllowed(robots: ParsedRobots, userAgent: string, pathWithQuery: string): RobotsDecision {
  const { rules, agent } = rulesFor(robots, userAgent);
  const target = normalisePath(pathWithQuery || '/');
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!patternToRegExp(normalisePath(r.path)).test(target)) continue;
    if (
      !best ||
      r.path.length > best.path.length ||
      (r.path.length === best.path.length && r.allow && !best.allow)
    ) {
      best = r;
    }
  }
  return { allowed: best ? best.allow : true, rule: best, agent };
}
