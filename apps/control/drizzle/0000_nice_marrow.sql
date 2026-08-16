CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"width_px" integer,
	"height_px" integer,
	"duration_sec" numeric(8, 3),
	"fps" numeric(5, 2),
	"face_detected" boolean,
	"inter_pupillary_px" integer,
	"parent_asset_id" uuid,
	"produced_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "assets_storage_key_uq" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"face_set" jsonb,
	"body_ref" jsonb,
	"wardrobe" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"anchor_tokens" text[] DEFAULT '{}' NOT NULL,
	"prohibited_changes" text[] DEFAULT '{}' NOT NULL,
	"platform_bindings" jsonb,
	"lora_asset_id" uuid,
	"voice_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"locked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"title" text,
	"logline" text,
	"hook" text,
	"cliffhanger" text,
	"script_md" text,
	"target_duration_sec" integer DEFAULT 75 NOT NULL,
	"status" text DEFAULT 'outline' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "episodes_project_index_uq" UNIQUE("project_id","index")
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"take_id" uuid NOT NULL,
	"tier" integer NOT NULL,
	"check_name" text NOT NULL,
	"score" numeric(5, 4),
	"passed" boolean NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shot_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text,
	"mode" text NOT NULL,
	"prompt_text" text NOT NULL,
	"negative_text" text,
	"seed" bigint,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_job_ref" text,
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"latency_ms" integer,
	"cost_micro_usd" bigint,
	"accepted" boolean,
	"failure_code" text,
	"failure_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gj_shot_attempt_uq" UNIQUE("shot_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "hook_concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_episode_id" uuid,
	"source_take_ids" uuid[] DEFAULT '{}' NOT NULL,
	"hook_type" text NOT NULL,
	"theme_tags" text[] DEFAULT '{}' NOT NULL,
	"emotion_tag" text,
	"summary" text NOT NULL,
	"tier" text DEFAULT 'L0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"interior" boolean DEFAULT true NOT NULL,
	"reference_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"anchor_tokens" text[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"locked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"synopsis" text,
	"style_profile_id" uuid,
	"aspect_ratio" text DEFAULT '9:16' NOT NULL,
	"language" text DEFAULT 'en-US' NOT NULL,
	"rights_ref" jsonb,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timeline_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output_asset_id" uuid,
	"ffmpeg_log" text,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"duration_sec" integer NOT NULL,
	"variant_key" text NOT NULL,
	"burned_subtitle" boolean DEFAULT true NOT NULL,
	"impressions" bigint,
	"installs" integer,
	"spend_micro_usd" bigint,
	"d0_roas" numeric(6, 3),
	"is_winner" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"location_id" uuid,
	"time_of_day" text,
	"summary" text,
	"state_in" jsonb,
	"state_out" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scenes_episode_index_uq" UNIQUE("episode_id","index")
);
--> statement-breakpoint
CREATE TABLE "shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"shot_type" text NOT NULL,
	"camera_move" text,
	"action" text NOT NULL,
	"emotion" text,
	"dialogue" text,
	"duration_sec" numeric(4, 1) DEFAULT '4.0' NOT NULL,
	"character_ids" uuid[] DEFAULT '{}' NOT NULL,
	"continuity_from_shot_id" uuid,
	"tier" text DEFAULT 'L1' NOT NULL,
	"cover_shot_ids" jsonb,
	"carries_plot" boolean DEFAULT true NOT NULL,
	"safety_profile" text DEFAULT 'standard' NOT NULL,
	"provider_hint" text,
	"prompt_override" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"selected_take_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shots_duration_ck" CHECK ("shots"."duration_sec" > 0 AND "shots"."duration_sec" <= 10)
);
--> statement-breakpoint
CREATE TABLE "style_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"negative_prompt" text,
	"reference_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"locked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shot_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"eval_summary" jsonb,
	"human_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timeline_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"take_id" uuid,
	"trim_start_sec" numeric(6, 3) DEFAULT '0' NOT NULL,
	"trim_end_sec" numeric(6, 3),
	"transition" text DEFAULT 'cut' NOT NULL,
	"voice_asset_id" uuid,
	"sfx_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"subtitle_text" text,
	CONSTRAINT "timeline_clips_timeline_index_uq" UNIQUE("timeline_id","index")
);
--> statement-breakpoint
CREATE TABLE "timelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "timelines_episode_version_uq" UNIQUE("episode_id","version")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_take_id_takes_id_fk" FOREIGN KEY ("take_id") REFERENCES "public"."takes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_shot_id_shots_id_fk" FOREIGN KEY ("shot_id") REFERENCES "public"."shots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hook_concepts" ADD CONSTRAINT "hook_concepts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_timeline_id_timelines_id_fk" FOREIGN KEY ("timeline_id") REFERENCES "public"."timelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_concept_id_hook_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."hook_concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_shot_id_shots_id_fk" FOREIGN KEY ("shot_id") REFERENCES "public"."shots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_timeline_id_timelines_id_fk" FOREIGN KEY ("timeline_id") REFERENCES "public"."timelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_take_id_takes_id_fk" FOREIGN KEY ("take_id") REFERENCES "public"."takes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_sha_idx" ON "assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "eval_take_idx" ON "eval_results" USING btree ("take_id","tier");--> statement-breakpoint
CREATE INDEX "gj_shot_idx" ON "generation_jobs" USING btree ("shot_id");--> statement-breakpoint
CREATE INDEX "gj_analytics_idx" ON "generation_jobs" USING btree ("provider_id","model_id","status","created_at");--> statement-breakpoint
CREATE INDEX "renders_concept_idx" ON "renders" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "renders_perf_idx" ON "renders" USING btree ("platform","is_winner","d0_roas");--> statement-breakpoint
CREATE INDEX "shots_scene_idx" ON "shots" USING btree ("scene_id","index");--> statement-breakpoint
CREATE INDEX "shots_status_idx" ON "shots" USING btree ("status");