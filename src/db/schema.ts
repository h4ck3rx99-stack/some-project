/**
 * D1 schema (Drizzle). TEXT ids, INTEGER unix-ms timestamps.
 * After editing: `npm run db:generate` to create a migration in migrations/.
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: text('role', { enum: ['user', 'admin'] })
    .notNull()
    .default('user'),
  createdAt: integer('created_at').notNull(),
});

export const loginTokens = sqliteTable(
  'login_tokens',
  {
    id: text('id').primaryKey(),
    /** Null until the link is used; users are created on verify, not on request. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    ipHash: text('ip_hash'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('login_tokens_user_idx').on(t.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    csrfSecret: text('csrf_secret').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan', { enum: ['free', 'store', 'agency', 'vendor'] })
    .notNull()
    .default('free'),
  status: text('status', { enum: ['active', 'past_due', 'cancelled', 'trialing'] })
    .notNull()
    .default('active'),
  currentPeriodEnd: integer('current_period_end'),
  billingProvider: text('billing_provider'),
  providerCustomerId: text('provider_customer_id'),
  providerSubscriptionId: text('provider_subscription_id'),
  whiteLabelName: text('white_label_name'),
  whiteLabelLogoUrl: text('white_label_logo_url'),
  whiteLabelHideFooter: integer('white_label_hide_footer').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const accountMembers = sqliteTable(
  'account_members',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('owner'),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.userId] }), index('account_members_user_idx').on(t.userId)],
);

export const stores = sqliteTable(
  'stores',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    domain: text('domain').notNull(),
    name: text('name').notNull(),
    monitoring: integer('monitoring').notNull().default(0),
    verifyToken: text('verify_token').notNull(),
    verifiedAt: integer('verified_at'),
    testCheckoutEndpoint: text('test_checkout_endpoint'),
    testModeConfirmedAt: integer('test_mode_confirmed_at'),
    badgeEnabled: integer('badge_enabled').notNull().default(0),
    lastScanId: text('last_scan_id'),
    lastScore: integer('last_score'),
    lastManualScanAt: integer('last_manual_scan_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('stores_account_domain_uq').on(t.accountId, t.domain),
    index('stores_account_idx').on(t.accountId),
  ],
);

export const scans = sqliteTable(
  'scans',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    url: text('url').notNull(),
    trigger: text('trigger', { enum: ['anonymous', 'manual', 'scheduled', 'api'] }).notNull(),
    requesterIpHash: text('requester_ip_hash'),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    phase: text('phase').notNull().default('discovery'),
    score: integer('score'),
    grade: text('grade'),
    categoryScoresJson: text('category_scores_json'),
    specVersionSeen: text('spec_version_seen'),
    productsSampled: integer('products_sampled').notNull().default(0),
    requestsMade: integer('requests_made').notNull().default(0),
    includeCheckout: integer('include_checkout').notNull().default(0),
    alertedAt: integer('alerted_at'),
    publicSlug: text('public_slug').notNull().unique(),
    isPublic: integer('is_public').notNull().default(0),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('scans_domain_finished_idx').on(t.domain, t.finishedAt),
    index('scans_store_finished_idx').on(t.storeId, t.finishedAt),
    index('scans_account_idx').on(t.accountId),
    index('scans_created_idx').on(t.createdAt),
  ],
);

export const checkResults = sqliteTable(
  'check_results',
  {
    id: text('id').primaryKey(),
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    category: text('category').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    summary: text('summary').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    fixGuide: text('fix_guide').notNull(),
    metaJson: text('meta_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('check_results_scan_check_uq').on(t.scanId, t.checkId)],
);

export const scanJobs = sqliteTable(
  'scan_jobs',
  {
    id: text('id').primaryKey(),
    scanId: text('scan_id')
      .notNull()
      .unique()
      .references(() => scans.id, { onDelete: 'cascade' }),
    phase: text('phase').notNull(),
    inputJson: text('input_json').notNull(),
    stateJson: text('state_json').notNull(),
    attempts: integer('attempts').notNull().default(0),
    leaseId: text('lease_id'),
    lockedUntil: integer('locked_until'),
    runAfter: integer('run_after').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('scan_jobs_run_idx').on(t.runAfter, t.lockedUntil)],
);

export const alertChannels = sqliteTable(
  'alert_channels',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['email', 'webhook', 'slack'] }).notNull(),
    targetEncrypted: text('target_encrypted').notNull(),
    label: text('label').notNull(),
    verifiedAt: integer('verified_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('alert_channels_account_idx').on(t.accountId)],
);

export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    scanId: text('scan_id').references(() => scans.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
    channelId: text('channel_id').references(() => alertChannels.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['sent', 'failed'] }).notNull(),
    error: text('error'),
    sentAt: integer('sent_at').notNull(),
  },
  (t) => [
    index('alerts_account_sent_idx').on(t.accountId, t.sentAt),
    index('alerts_store_idx').on(t.storeId),
    index('alerts_scan_idx').on(t.scanId),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull().unique(),
    prefix: text('prefix').notNull().unique(),
    label: text('label').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('api_keys_account_idx').on(t.accountId)],
);

export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull().unique(),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  processedAt: integer('processed_at'),
  error: text('error'),
});

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: integer('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('rate_limits_window_idx').on(t.windowStart)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id'),
    userId: text('user_id'),
    action: text('action').notNull(),
    detailsJson: text('details_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('audit_log_account_idx').on(t.accountId)],
);

export const cronRuns = sqliteTable('cron_runs', {
  name: text('name').primaryKey(),
  lastRunAt: integer('last_run_at').notNull(),
  lastDurationMs: integer('last_duration_ms'),
  lastResult: text('last_result'),
});
