CREATE TABLE `match_events` (
	`id` text PRIMARY KEY NOT NULL,
	`match_date` text NOT NULL,
	`season_year` integer NOT NULL,
	`season_weight` integer DEFAULT 1 NOT NULL,
	`home_school_id` text NOT NULL,
	`opponent_school_id` text NOT NULL,
	`position` text NOT NULL,
	`home_player_1_code` text NOT NULL,
	`home_player_2_code` text,
	`scores_json` text NOT NULL,
	`point_differential` integer NOT NULL,
	`home_won` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_event_unique` ON `match_events` (`home_school_id`,`opponent_school_id`,`match_date`,`position`);--> statement-breakpoint
CREATE INDEX `match_events_home_date_idx` ON `match_events` (`home_school_id`,`match_date`);--> statement-breakpoint
CREATE TABLE `opponent_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`home_school_id` text NOT NULL,
	`opponent_school_id` text NOT NULL,
	`position` text NOT NULL,
	`current_elo` real NOT NULL,
	`total_weight` real NOT NULL,
	`matches_used` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opponent_position_unique` ON `opponent_positions` (`home_school_id`,`opponent_school_id`,`position`);--> statement-breakpoint
CREATE TABLE `player_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`alias_code` text NOT NULL,
	`player_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_alias_school_code_unique` ON `player_aliases` (`school_id`,`alias_code`);--> statement-breakpoint
CREATE INDEX `player_alias_player_idx` ON `player_aliases` (`player_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`player_code` text NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`gender` text NOT NULL,
	`rank` integer NOT NULL,
	`initial_elo` real NOT NULL,
	`current_elo` real NOT NULL,
	`first_season` integer NOT NULL,
	`last_season` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_school_code_unique` ON `players` (`school_id`,`player_code`);--> statement-breakpoint
CREATE INDEX `players_school_active_idx` ON `players` (`school_id`,`active`);--> statement-breakpoint
CREATE TABLE `schools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schools_name_unique` ON `schools` (`name`);