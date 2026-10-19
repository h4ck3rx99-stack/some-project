CREATE TABLE `account_members` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	PRIMARY KEY(`account_id`, `user_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_members_user_idx` ON `account_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_period_end` integer,
	`billing_provider` text,
	`provider_customer_id` text,
	`provider_subscription_id` text,
	`white_label_name` text,
	`white_label_logo_url` text,
	`white_label_hide_footer` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`target_encrypted` text NOT NULL,
	`label` text NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_channels_account_idx` ON `alert_channels` (`account_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`store_id` text,
	`scan_id` text,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`channel_id` text,
	`status` text NOT NULL,
	`error` text,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`channel_id`) REFERENCES `alert_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alerts_account_sent_idx` ON `alerts` (`account_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `alerts_store_idx` ON `alerts` (`store_id`);--> statement-breakpoint
CREATE INDEX `alerts_scan_idx` ON `alerts` (`scan_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`label` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_prefix_unique` ON `api_keys` (`prefix`);--> statement-breakpoint
CREATE INDEX `api_keys_account_idx` ON `api_keys` (`account_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`user_id` text,
	`action` text NOT NULL,
	`details_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_account_idx` ON `audit_log` (`account_id`);--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`check_id` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`evidence_json` text NOT NULL,
	`fix_guide` text NOT NULL,
	`meta_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_results_scan_check_uq` ON `check_results` (`scan_id`,`check_id`);--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run_at` integer NOT NULL,
	`last_duration_ms` integer,
	`last_result` text
);
--> statement-breakpoint
CREATE TABLE `login_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_tokens_token_hash_unique` ON `login_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `login_tokens_user_idx` ON `login_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limits_window_idx` ON `rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `scan_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`phase` text NOT NULL,
	`input_json` text NOT NULL,
	`state_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`locked_until` integer,
	`run_after` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_jobs_scan_id_unique` ON `scan_jobs` (`scan_id`);--> statement-breakpoint
CREATE INDEX `scan_jobs_run_idx` ON `scan_jobs` (`run_after`,`locked_until`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text,
	`account_id` text,
	`domain` text NOT NULL,
	`url` text NOT NULL,
	`trigger` text NOT NULL,
	`requester_ip_hash` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'discovery' NOT NULL,
	`score` integer,
	`grade` text,
	`category_scores_json` text,
	`spec_version_seen` text,
	`products_sampled` integer DEFAULT 0 NOT NULL,
	`requests_made` integer DEFAULT 0 NOT NULL,
	`include_checkout` integer DEFAULT 0 NOT NULL,
	`alerted_at` integer,
	`public_slug` text NOT NULL,
	`is_public` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scans_public_slug_unique` ON `scans` (`public_slug`);--> statement-breakpoint
CREATE INDEX `scans_domain_finished_idx` ON `scans` (`domain`,`finished_at`);--> statement-breakpoint
CREATE INDEX `scans_store_finished_idx` ON `scans` (`store_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `scans_account_idx` ON `scans` (`account_id`);--> statement-breakpoint
CREATE INDEX `scans_created_idx` ON `scans` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_secret` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`url` text NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`monitoring` integer DEFAULT 0 NOT NULL,
	`verify_token` text NOT NULL,
	`verified_at` integer,
	`test_checkout_endpoint` text,
	`test_mode_confirmed_at` integer,
	`badge_enabled` integer DEFAULT 0 NOT NULL,
	`last_scan_id` text,
	`last_score` integer,
	`last_manual_scan_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stores_account_domain_uq` ON `stores` (`account_id`,`domain`);--> statement-breakpoint
CREATE INDEX `stores_account_idx` ON `stores` (`account_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`processed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_event_id_unique` ON `webhook_events` (`event_id`);