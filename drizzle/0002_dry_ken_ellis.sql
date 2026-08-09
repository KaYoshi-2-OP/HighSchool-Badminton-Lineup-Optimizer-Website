CREATE TABLE `player_seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`school_id` text NOT NULL,
	`season` integer NOT NULL,
	`rank` integer NOT NULL,
	`initialized_elo` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_season_unique` ON `player_seasons` (`player_id`,`season`);--> statement-breakpoint
CREATE INDEX `player_seasons_school_season_idx` ON `player_seasons` (`school_id`,`season`);