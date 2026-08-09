CREATE TABLE `opponent_calibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`home_school_id` text NOT NULL,
	`opponent_school_id` text NOT NULL,
	`elo_offset` real NOT NULL,
	`actual_wins` real NOT NULL,
	`projected_wins` real NOT NULL,
	`event_count` integer NOT NULL,
	`meet_count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opponent_calibration_unique` ON `opponent_calibrations` (`home_school_id`,`opponent_school_id`);