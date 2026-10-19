import type { Category, Severity } from '../scan/types';

/** Points a check is worth inside its category, by severity. */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 5,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Category weights for the overall score (renormalised over applicable categories). */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  discovery: 30,
  catalog: 20,
  products: 25,
  consistency: 15,
  basics: 10,
  // Only counted when the store's ownership is verified and checkout test mode is configured.
  checkout: 20,
};

export const CATEGORY_LABELS: Record<Category, string> = {
  discovery: 'Discovery',
  catalog: 'Catalog API',
  products: 'Product data',
  consistency: 'Consistency',
  basics: 'Site basics',
  checkout: 'Checkout',
};

export const GRADE_BANDS = [
  { min: 90, grade: 'Agent-ready' },
  { min: 70, grade: 'Mostly ready' },
  { min: 40, grade: 'Needs work' },
  { min: 0, grade: 'Not ready' },
] as const;

export type Grade = (typeof GRADE_BANDS)[number]['grade'];

/** Product-data check thresholds (share of sampled pages). */
export const PRODUCT_THRESHOLDS = { pass: 0.9, warn: 0.6 };

export const LATENCY = {
  profileTtfb: { pass: 800, warn: 1500 },
  catalog: { pass: 1500, warn: 3000 },
  homepageTtfb: { pass: 800, warn: 1800 },
};
