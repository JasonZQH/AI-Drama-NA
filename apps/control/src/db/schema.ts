import type {
  BodyRef,
  ContentTier,
  ContinuityState,
  EpisodeStatus,
  EvalSummary,
  FaceSet,
  FailureCode,
  GenMode,
  HookType,
  JobStatus,
  Outfit,
  PlatformBindings,
  ProducedBy,
  ProjectStatus,
  RightsRef,
  SafetyProfile,
  ShotStatus,
  ShotType,
  TakeStatus,
  TimeOfDay,
  TimelineStatus,
  Transition,
  AdPlatform,
  AssetKind,
  CameraMove,
} from '@ai-drama/contracts'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * 数据模型（02-data-model.md）。六条设计原则：
 * 1. 母版不可变：assets 只增不改，修改 = 新 asset + parentAssetId 指回来源
 * 2. 生成即留痕：每次 provider 调用都有 generation_jobs 一行，无论成败
 * 3. 一个 Shot 多个 Take：选片是显式动作，不是覆盖
 * 4. 状态是枚举不是布尔：禁止 is_done 这类字段
 * 5. 成本以整数微美元存储：浮点算钱迟早出问题
 * 6. JSONB 装可变结构，列装可查询字段：要 GROUP BY 的必须是列
 */

/** seed 与业务代码用同一套列类型，避免字面量与枚举漂移 */
export type ShotTypeCol = ShotType

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  synopsis: text('synopsis'),
  styleProfileId: uuid('style_profile_id'),
  aspectRatio: text('aspect_ratio').notNull().default('9:16'),
  // 北美 R 级为主市场（00-overview.md §2.5）
  language: text('language').notNull().default('en-US'),
  rightsRef: jsonb('rights_ref').$type<RightsRef | null>(), // 预留：授权链
  ownerId: text('owner_id').notNull().default('local'), // 预留：多用户
  status: text('status').$type<ProjectStatus>().notNull().default('draft'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(), // 第几集，从 1 开始
    title: text('title'),
    logline: text('logline'),
    hook: text('hook'), // 开场钩子
    cliffhanger: text('cliffhanger'), // 结尾悬念
    scriptMd: text('script_md'),
    targetDurationSec: integer('target_duration_sec').notNull().default(75), // 60–90 秒区间的典型值
    status: text('status').$type<EpisodeStatus>().notNull().default('outline'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [unique('episodes_project_index_uq').on(t.projectId, t.index)],
)

export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    locationId: uuid('location_id'),
    timeOfDay: text('time_of_day').$type<TimeOfDay>(),
    summary: text('summary'),
    stateIn: jsonb('state_in').$type<ContinuityState>(), // 进场可见状态
    stateOut: jsonb('state_out').$type<ContinuityState>(), // 出场可见状态
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [unique('scenes_episode_index_uq').on(t.episodeId, t.index)],
)

/** 全系统最重要的表 */
export const shots = pgTable(
  'shots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),

    // ── Shot Intent：结构化意图，不是 prompt ──
    shotType: text('shot_type').$type<ShotType>().notNull(),
    cameraMove: text('camera_move').$type<CameraMove>(),
    action: text('action').notNull(),
    emotion: text('emotion'),
    dialogue: text('dialogue'), // 驱动 TTS
    durationSec: numeric('duration_sec', { precision: 4, scale: 1 }).notNull().default('4.0'),

    // ── 一致性引用 ──
    characterIds: uuid('character_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** 依赖的前序镜头；生成时解析其 selectedTake 末帧作首帧条件 */
    continuityFromShotId: uuid('continuity_from_shot_id'),

    // ── 生成控制 ──
    tier: text('tier').$type<ContentTier>().notNull().default('L1'),
    coverShotIds: jsonb('cover_shot_ids').$type<{ L1?: string; L0?: string }>(),
    carriesPlot: boolean('carries_plot').notNull().default(true),
    safetyProfile: text('safety_profile').$type<SafetyProfile>().notNull().default('standard'),
    providerHint: text('provider_hint'), // null = 自动路由
    promptOverride: text('prompt_override'),

    // ── 状态 ──
    status: text('status').$type<ShotStatus>().notNull().default('draft'),
    selectedTakeId: uuid('selected_take_id'),
    attemptCount: integer('attempt_count').notNull().default(0),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('shots_scene_idx').on(t.sceneId, t.index),
    index('shots_status_idx').on(t.status),
    /**
     * 最后一道防线。zod 的 ShotIntent 已经拦 >10 秒，但绕过它直接写库的路径
     * （手写 SQL、迁移脚本、将来某条没走校验的接口）不该能塞进非法时长。
     */
    check('shots_duration_ck', sql`${t.durationSec} > 0 AND ${t.durationSec} <= 10`),
  ],
)

// ── 一致性资产：三路分离（ADR-0008）──

export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(), // 注入 prompt 的固定描述

  /**
   * 可空：角色卡先于参考图存在（13-character-assets.md §3 的生产顺序是
   * 抽角色卡 → 出图 → 精修 → 入库 → 锁定）。「三路齐备」的闸门在 lockedAt。
   */
  faceSet: jsonb('face_set').$type<FaceSet | null>(),
  bodyRef: jsonb('body_ref').$type<BodyRef | null>(),
  wardrobe: jsonb('wardrobe')
    .$type<Outfit[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),

  anchorTokens: text('anchor_tokens')
    .array()
    .notNull()
    .default(sql`'{}'`),
  prohibitedChanges: text('prohibited_changes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  platformBindings: jsonb('platform_bindings').$type<PlatformBindings>(),

  loraAssetId: uuid('lora_asset_id'),
  voiceId: text('voice_id'),
  version: integer('version').notNull().default(1),
  /** 三路资产齐备的闸门；锁定后才允许进入 S5 批量生成 */
  lockedAt: timestamp('locked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

/** 场景参考图：全景、无人物、环境完整（13-character-assets.md §2.5） */
export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  interior: boolean('interior').notNull().default(true),
  referenceAssetIds: uuid('reference_asset_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  anchorTokens: text('anchor_tokens')
    .array()
    .notNull()
    .default(sql`'{}'`),
  version: integer('version').notNull().default(1),
  lockedAt: timestamp('locked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const styleProfiles = pgTable('style_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  negativePrompt: text('negative_prompt'),
  referenceAssetIds: uuid('reference_asset_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  version: integer('version').notNull().default(1),
  lockedAt: timestamp('locked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ── 资产 ──

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AssetKind>().notNull(),
    storageKey: text('storage_key').notNull(), // S3 key，唯一定位
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    widthPx: integer('width_px'),
    heightPx: integer('height_px'),
    durationSec: numeric('duration_sec', { precision: 8, scale: 3 }),
    fps: numeric('fps', { precision: 5, scale: 2 }),
    // 入库质量闸门（参考图专用，13-character-assets.md §2.1）
    faceDetected: boolean('face_detected'),
    interPupillaryPx: integer('inter_pupillary_px'), // 下限 48，安全线 100
    parentAssetId: uuid('parent_asset_id'), // 血缘
    producedBy: text('produced_by').$type<ProducedBy>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('assets_sha_idx').on(t.sha256), // 内容去重
    unique('assets_storage_key_uq').on(t.storageKey),
  ],
)

/** C4 的落地，也是全系统最有复利的一张表 */
export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shotId: uuid('shot_id')
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),

    // ── 路由与可复现性 ──
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    modelVersion: text('model_version'),
    mode: text('mode').$type<GenMode>().notNull(),
    promptText: text('prompt_text').notNull(),
    negativeText: text('negative_text'),
    seed: bigint('seed', { mode: 'number' }),
    params: jsonb('params')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    inputAssetIds: uuid('input_asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),

    // ── 执行 ──
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    providerJobRef: text('provider_job_ref'),
    queuedAt: timestamp('queued_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    latencyMs: integer('latency_ms'),

    // ── 结果与成本 ──
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),
    accepted: boolean('accepted'),
    failureCode: text('failure_code').$type<FailureCode>(),
    failureDetail: text('failure_detail'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('gj_shot_idx').on(t.shotId),
    index('gj_analytics_idx').on(t.providerId, t.modelId, t.status, t.createdAt),
    /** 幂等的物理保证：崩溃恢复重放同一 attempt 不会产生第二行（05 §8） */
    unique('gj_shot_attempt_uq').on(t.shotId, t.attempt),
  ],
)

export const takes = pgTable('takes', {
  id: uuid('id').primaryKey().defaultRandom(),
  shotId: uuid('shot_id')
    .notNull()
    .references(() => shots.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id')
    .notNull()
    .references(() => generationJobs.id),
  assetId: uuid('asset_id')
    .notNull()
    .references(() => assets.id),
  status: text('status').$type<TakeStatus>().notNull().default('candidate'),
  evalSummary: jsonb('eval_summary').$type<EvalSummary>(),
  humanNote: text('human_note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const evalResults = pgTable(
  'eval_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    takeId: uuid('take_id')
      .notNull()
      .references(() => takes.id, { onDelete: 'cascade' }),
    tier: integer('tier').notNull(), // 0..4，定义见 03-pipeline.md §4
    checkName: text('check_name').notNull(),
    score: numeric('score', { precision: 5, scale: 4 }),
    passed: boolean('passed').notNull(),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('eval_take_idx').on(t.takeId, t.tier)],
)

// ── 剪辑与渲染 ──

export const timelines = pgTable(
  'timelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    status: text('status').$type<TimelineStatus>().notNull().default('draft'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [unique('timelines_episode_version_uq').on(t.episodeId, t.version)],
)

export const timelineClips = pgTable(
  'timeline_clips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timelineId: uuid('timeline_id')
      .notNull()
      .references(() => timelines.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    takeId: uuid('take_id').references(() => takes.id),
    trimStartSec: numeric('trim_start_sec', { precision: 6, scale: 3 }).notNull().default('0'),
    trimEndSec: numeric('trim_end_sec', { precision: 6, scale: 3 }),
    transition: text('transition').$type<Transition>().notNull().default('cut'),
    voiceAssetId: uuid('voice_asset_id'),
    sfxAssetIds: uuid('sfx_asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    subtitleText: text('subtitle_text'),
  },
  (t) => [unique('timeline_clips_timeline_index_uq').on(t.timelineId, t.index)],
)

export const renderJobs = pgTable('render_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  timelineId: uuid('timeline_id')
    .notNull()
    .references(() => timelines.id),
  status: text('status').$type<JobStatus>().notNull().default('queued'),
  outputAssetId: uuid('output_asset_id'),
  ffmpegLog: text('ffmpeg_log'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
})

// ── 素材层：不是正片的附属，是一等实体（约束 C8）──

export const hookConcepts = pgTable('hook_concepts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sourceEpisodeId: uuid('source_episode_id'),
  sourceTakeIds: uuid('source_take_ids')
    .array()
    .notNull()
    .default(sql`'{}'`),
  hookType: text('hook_type').$type<HookType>().notNull(),
  /** 投放归因的基础：没有标签就没有归因，没有归因就只能靠感觉调创意 */
  themeTags: text('theme_tags')
    .array()
    .notNull()
    .default(sql`'{}'`),
  emotionTag: text('emotion_tag'),
  summary: text('summary').notNull(),
  tier: text('tier').$type<ContentTier>().notNull().default('L0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const renders = pgTable(
  'renders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => hookConcepts.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    platform: text('platform').$type<AdPlatform>().notNull(),
    durationSec: integer('duration_sec').notNull(), // 9 / 15 / 21 / 30
    variantKey: text('variant_key').notNull(), // 首帧+字幕+音轨+CTA 的组合键
    burnedSubtitle: boolean('burned_subtitle').notNull().default(true),
    // 投放回传（由外部广告平台写入）
    impressions: bigint('impressions', { mode: 'number' }),
    installs: integer('installs'),
    spendMicroUsd: bigint('spend_micro_usd', { mode: 'number' }),
    d0Roas: numeric('d0_roas', { precision: 6, scale: 3 }),
    isWinner: boolean('is_winner'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('renders_concept_idx').on(t.conceptId),
    index('renders_perf_idx').on(t.platform, t.isWinner, t.d0Roas),
  ],
)
