CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`normalized_username` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_iterations` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_unique` ON `accounts` (`normalized_username`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`normalized_username` text PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`locked_until` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_account_idx` ON `sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
DROP INDEX `schools_name_unique`;--> statement-breakpoint
ALTER TABLE `schools` ADD `account_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `schools_account_name_unique` ON `schools` (`account_id`,`name`);--> statement-breakpoint
CREATE INDEX `schools_account_idx` ON `schools` (`account_id`);--> statement-breakpoint
ALTER TABLE `match_events` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `opponent_calibrations` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `opponent_positions` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `player_aliases` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `player_seasons` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `players` ADD `account_id` text;