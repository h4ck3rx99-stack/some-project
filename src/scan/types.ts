import type { FetchSession } from '../lib/safeFetch';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'error';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Category = 'discovery' | 'catalog' | 'products' | 'consistency' | 'basics' | 'checkout';
export const CATEGORIES: Category[] = ['discovery', 'catalog', 'products', 'consistency', 'basics', 'checkout'];

/** Phases a scan job moves through. `products:<offset>` fetches product pages in chunks. */
export type Phase = 'discovery' | 'catalog' | `products:${number}` | 'consistency' | 'basics' | 'checkout' | 'finalize' | 'done';

export interface Evidence {
  label: string;
  url?: string;
  expected?: string;
  found?: string;
}

export interface CheckResult {
  status: CheckStatus;
  summary: string;
  evidence: Evidence[];
  /** Slug of content/fix/<slug>.md. Defaults to the check id. */
  fixGuide?: string;
  meta?: Record<string, unknown>;
}

export interface CheckRecord extends Required<Omit<CheckResult, 'meta'>> {
  checkId: string;
  title: string;
  category: Category;
  severity: Severity;
  meta?: Record<string, unknown>;
}

/** Engine phase in which a check runs (data it needs is gathered by then). */
export type CheckPhase = 'discovery' | 'catalog' | 'consistency' | 'basics' | 'checkout';

export interface CheckDefinition {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  phase: CheckPhase;
  /** One sentence: why this matters to AI shopping agents. Shown on reports. */
  why: string;
  dependsOn?: string[];
  requires?: { verifiedOwnership?: boolean; capability?: string };
  run(ctx: ScanContext): Promise<CheckResult>;
}

/* ---------- serialisable scan state (persisted in scan_jobs.state_json) ---------- */

export interface FetchSummary {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  headers: Record<string, string>;
  ttfbMs: number;
  totalMs: number;
  redirects: { from: string; to: string; status: number }[];
  error?: { kind: string; message: string };
  truncated?: boolean;
}

export interface ExtractedOffer {
  price?: string;
  lowPrice?: string;
  highPrice?: string;
  priceCurrency?: string;
  availability?: string;
  hasShippingDetails: boolean;
  hasReturnPolicy: boolean;
}

export interface ExtractedProduct {
  type: 'Product' | 'ProductGroup';
  name?: string;
  hasImage: boolean;
  hasBrand: boolean;
  sku?: string;
  gtin?: string;
  mpn?: string;
  url?: string;
  offers: ExtractedOffer[];
  hasReturnPolicy: boolean;
}

export interface ProductPage {
  url: string;
  status: number;
  error?: string;
  products: ExtractedProduct[];
  jsonLdBlocks: number;
  jsonLdErrors: number;
}

export interface CatalogVariant {
  id?: string;
  sku?: string;
  url?: string;
  amount?: unknown;
  currency?: unknown;
  available?: boolean;
}
export interface CatalogProduct {
  id?: string;
  title?: string;
  url?: string;
  variants: CatalogVariant[];
}

export interface ScanState {
  /** The JSON profile body, if parsed. */
  profile?: { fetch: FetchSummary; json?: unknown; parseError?: string; bodySnippet?: string };
  profileVersion?: string;
  validationVersion?: string;
  restEndpoint?: string;
  homepage?: { fetch: FetchSummary; title?: string };
  catalog?: { query: string; fetch?: FetchSummary; json?: unknown; skippedReason?: string; products: CatalogProduct[] };
  robots?: { fetch: FetchSummary; text?: string };
  sitemaps?: { tried: string[]; found: string[]; productSitemap?: string };
  productUrls?: string[];
  sampled?: string[];
  robotsBlocked?: { url: string; rule: string }[];
  productPages?: ProductPage[];
  checkout?: { createFetch?: FetchSummary; json?: unknown; cancelFetch?: FetchSummary; cancelJson?: unknown; sessionId?: string; itemId?: string; skippedReason?: string };
  results: Record<string, CheckRecord>;
  requestsMade: number;
}

export interface PlanLimits {
  maxProducts: number;
  maxRequests: number;
}

export interface ScanInput {
  scanId: string;
  url: string; // normalised origin, e.g. https://shop.example.com
  domain: string;
  limits: PlanLimits;
  verifiedOwnership: boolean;
  testCheckoutEndpoint?: string | null;
  testModeConfirmed: boolean;
}

export interface ScanContext extends ScanInput {
  http: FetchSession;
  state: ScanState;
  appUrl: string;
  userAgent: string;
  now: () => number;
  capture?: (name: string, body: string) => Promise<void>;
}
