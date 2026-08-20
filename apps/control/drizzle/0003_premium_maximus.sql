DROP INDEX "shots_scene_idx";--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_scene_index_uq" UNIQUE("scene_id","index");