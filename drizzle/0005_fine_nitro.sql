CREATE TABLE `season_formats` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`home_school_id` text NOT NULL,
	`season` integer NOT NULL,
	`boys_singles` integer NOT NULL,
	`girls_singles` integer NOT NULL,
	`boys_doubles` integer NOT NULL,
	`girls_doubles` integer NOT NULL,
	`mixed_doubles` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_format_unique` ON `season_formats` (`account_id`,`home_school_id`,`season`);--> statement-breakpoint
CREATE INDEX `season_formats_home_season_idx` ON `season_formats` (`home_school_id`,`season`);