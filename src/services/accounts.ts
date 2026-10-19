import { and, eq } from 'drizzle-orm';
import { effectivePlan, type Plan } from '../config/plans';
import { getDb, schema } from '../db/client';
import { newId } from '../lib/crypto';

export type Account = typeof schema.accounts.$inferSelect;
export type Store = typeof schema.stores.$inferSelect;

export function planOf(a: Pick<Account, 'plan' | 'status' | 'currentPeriodEnd'>, now = Date.now()): Plan {
  return effectivePlan(a.plan, a.status, a.currentPeriodEnd, now);
}

/** Find or create the user + their personal account. */
export async function ensureUser(d1: D1Database, email: string, role: 'user' | 'admin') {
  const db = getDb(d1);
  const e = email.trim().toLowerCase();
  let user = await db.query.users.findFirst({ where: eq(schema.users.email, e) });
  if (!user) {
    const now = Date.now();
    const userId = newId('usr_');
    const accountId = newId('acc_');
    await db.batch([
      db.insert(schema.users).values({ id: userId, email: e, role, createdAt: now }),
      db
        .insert(schema.accounts)
        .values({ id: accountId, name: e.split('@')[1] ?? 'My account', createdAt: now }),
      db.insert(schema.accountMembers).values({ accountId, userId, role: 'owner' }),
    ]);
    user = (await db.query.users.findFirst({ where: eq(schema.users.id, userId) }))!;
  } else if (role === 'admin' && user.role !== 'admin') {
    await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id));
    user = { ...user, role: 'admin' };
  }
  return user;
}

/** The (first) account a user belongs to. CartProbe MVP: one account per user. */
export async function accountForUser(d1: D1Database, userId: string): Promise<Account | null> {
  const rows = await getDb(d1)
    .select({ a: schema.accounts })
    .from(schema.accountMembers)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.accountMembers.accountId))
    .where(eq(schema.accountMembers.userId, userId))
    .limit(1);
  return rows[0]?.a ?? null;
}

export async function isMember(d1: D1Database, accountId: string, userId: string): Promise<boolean> {
  const row = await getDb(d1)
    .select({ u: schema.accountMembers.userId })
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, accountId), eq(schema.accountMembers.userId, userId)))
    .limit(1);
  return row.length === 1;
}

/**
 * The single gate for store access: returns the store only if `userId` is a member of the
 * store's account. Every route touching a store goes through this (see routes/helpers.ts).
 */
export async function storeForUser(d1: D1Database, storeId: string, userId: string): Promise<Store | null> {
  const rows = await getDb(d1)
    .select({ s: schema.stores })
    .from(schema.stores)
    .innerJoin(schema.accountMembers, eq(schema.accountMembers.accountId, schema.stores.accountId))
    .where(and(eq(schema.stores.id, storeId), eq(schema.accountMembers.userId, userId)))
    .limit(1);
  return rows[0]?.s ?? null;
}
