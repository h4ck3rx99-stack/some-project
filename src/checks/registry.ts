import type { CheckDefinition } from '../scan/types';
import { basicsChecks } from './basics';
import { catalogChecks } from './catalog';
import { checkoutChecks } from './checkout';
import { consistencyChecks } from './consistency';
import { discoveryChecks } from './discovery';
import { productChecks } from './products';

/** Every check, in report order. Ids are stable: never rename one without a migration plan. */
export const CHECKS: CheckDefinition[] = [
  ...discoveryChecks,
  ...catalogChecks,
  ...productChecks,
  ...consistencyChecks,
  ...basicsChecks,
  ...checkoutChecks,
];

export const CHECKS_BY_ID = new Map(CHECKS.map((c) => [c.id, c]));
