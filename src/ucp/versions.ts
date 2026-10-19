/**
 * UCP spec versions vendored under schemas/ucp/<version>/ (sorted ascending).
 * Keep in sync with the folders; test/versions.test.ts enforces this.
 * All published releases (for "known version" checks) are listed in KNOWN_RELEASES.
 */
export const UCP_VERSIONS = ['2026-04-08', '2026-08-25'] as const;
export type VendoredVersion = (typeof UCP_VERSIONS)[number];

export const LATEST_VERSION: VendoredVersion = UCP_VERSIONS[UCP_VERSIONS.length - 1]!;
export const PREVIOUS_VERSION: VendoredVersion = UCP_VERSIONS[UCP_VERSIONS.length - 2]!;

/** Every dated release tag published in the UCP repository (v<date> tags), ascending. */
export const KNOWN_RELEASES = ['2026-01-11', '2026-01-23', '2026-04-08', '2026-08-25'] as const;

export const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isVendored(v: string): v is VendoredVersion {
  return (UCP_VERSIONS as readonly string[]).includes(v);
}

export type VersionStatus = 'latest' | 'previous' | 'older' | 'unknown';

/** Classify a declared protocol version against the vendored releases. */
export function classifyVersion(v: unknown): VersionStatus {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) return 'unknown';
  if (v === LATEST_VERSION) return 'latest';
  if (v === PREVIOUS_VERSION) return 'previous';
  if ((KNOWN_RELEASES as readonly string[]).includes(v)) return 'older';
  return 'unknown';
}
