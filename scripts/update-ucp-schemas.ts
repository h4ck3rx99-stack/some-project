/**
 * Refresh vendored UCP JSON Schemas.
 *
 * Usage:
 *   npx tsx scripts/update-ucp-schemas.ts 2026-08-25            # clones tag v2026-08-25 (network)
 *   npx tsx scripts/update-ucp-schemas.ts 2026-08-25 --from DIR # copies from an existing checkout
 *
 * Copies <spec>/source/schemas/** into schemas/ucp/<version>/ (relative $refs preserved),
 * refreshes schemas/ucp/LICENSE and records the source commit in schemas/ucp/NOTICE.
 * After running, add the version to src/ucp/versions.ts and run `npm run build:validators`.
 * Tests never call this script; it is a manual maintenance tool.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = 'https://github.com/Universal-Commerce-Protocol/ucp';
const [version, flag, fromDir] = process.argv.slice(2);
if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(version)) {
  console.error('Usage: update-ucp-schemas.ts <YYYY-MM-DD> [--from <checkout dir>]');
  process.exit(1);
}

let src: string;
let cleanup: string | undefined;
if (flag === '--from' && fromDir) {
  src = resolve(fromDir);
} else {
  cleanup = mkdtempSync(join(tmpdir(), 'ucp-'));
  execFileSync('git', ['clone', '--depth', '1', '--branch', `v${version}`, REPO, cleanup], {
    stdio: 'inherit',
  });
  src = cleanup;
}

const sha = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD']).toString().trim();
const schemaSrc = join(src, 'source', 'schemas');
if (!existsSync(schemaSrc)) throw new Error(`No source/schemas in ${src}`);

const root = resolve('schemas/ucp');
const dest = join(root, version);
rmSync(dest, { recursive: true, force: true });
cpSync(schemaSrc, dest, { recursive: true });
cpSync(join(src, 'LICENSE'), join(root, 'LICENSE'));

// Keep one NOTICE line per version.
const noticePath = join(root, 'NOTICE');
const header = [
  'CartProbe vendors JSON Schemas from the Universal Commerce Protocol (UCP) specification.',
  'Copyright 2026 UCP Authors. Licensed under the Apache License, Version 2.0 (see LICENSE in this folder).',
  `Source: ${REPO}`,
  'Files are copied unmodified from source/schemas/ at the commits listed below.',
  '',
];
const existing = existsSync(noticePath) ? readFileSync(noticePath, 'utf8').split('\n') : [];
const lines = new Map<string, string>();
for (const l of existing) {
  const m = /^- (\d{4}-\d{2}-\d{2}): /.exec(l);
  if (m) lines.set(m[1]!, l);
}
lines.set(version, `- ${version}: tag v${version}, commit ${sha}`);
const body = [...lines.keys()].sort().map((k) => lines.get(k)!);
writeFileSync(noticePath, [...header, ...body, ''].join('\n'));

if (cleanup) rmSync(cleanup, { recursive: true, force: true });
console.log(`Vendored UCP ${version} (${sha}) into ${dest}`);
