import { getDb, schema } from '../db/client';
import { newId } from '../lib/crypto';

export async function audit(
  d1: D1Database,
  action: string,
  details: Record<string, unknown> = {},
  who: { accountId?: string | null; userId?: string | null } = {},
) {
  await getDb(d1)
    .insert(schema.auditLog)
    .values({
      id: newId('aud_'),
      accountId: who.accountId ?? null,
      userId: who.userId ?? null,
      action,
      detailsJson: JSON.stringify(details).slice(0, 4000),
      createdAt: Date.now(),
    });
}
