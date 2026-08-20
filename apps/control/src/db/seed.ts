import { eq, inArray } from 'drizzle-orm'
import { createDb } from './client.js'
import * as s from './schema.js'

/**
 * demo project：1 集 / 3 场 / 12 镜 / 2 角色 / 2 场景，全部指向 mock provider。
 * 既是 M0 的验收载体，也是前端开发的固定夹具（02-data-model.md §9）。
 *
 * 12 镜是**刻意的最小夹具**，不是规模口径——真实一集是 10–25 镜。
 *
 * 幂等：重复跑先清掉同名 demo 项目，级联删除全部下游。
 */

/** 导出：集成测试要按它定位夹具项目，两边共用同一个真相而不是各写一份字面量 */
export const DEMO_TITLE = 'DEMO · Ashes of the Alpha'

const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL 未设置')

const { db, client } = createDb(url, 1)

/*
 * **先手动删掉引用 assets 的行，再删项目。**
 *
 * 文档字符串曾经声称「删项目即级联删全部下游」——一旦这个项目真的生成过东西，
 * 那句话就是假的：`assets` 是 projects 的直接子表（cascade），而 `takes.asset_id`
 * 与 `render_jobs.output_asset_id` 引用 assets 时**没有 cascade**。Postgres 删
 * 直接子表的顺序不保证在孙表之后，于是 assets 先被删、takes 还指着它：
 *
 *   23503 · Key (id)=(…) is still referenced from table "takes"
 *
 * 症状是「跑过一次生成之后就再也 seed 不了」，而那正是开发期最常做的事。
 * 这里按依赖顺序显式清掉那两张表，剩下的照旧交给级联。
 */
{
  const ids = (
    await db.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.title, DEMO_TITLE))
  ).map((p) => p.id)

  if (ids.length > 0) {
    const idsOf = async <T extends { id: string }>(rows: Promise<T[]>): Promise<string[]> =>
      (await rows).map((r) => r.id)

    // 从叶子往根删。三条 FK 都没有 cascade，顺序错一层就是一个 23503
    const assetIds = await idsOf(
      db.select({ id: s.assets.id }).from(s.assets).where(inArray(s.assets.projectId, ids)),
    )
    const timelineIds = await idsOf(
      db
        .select({ id: s.timelines.id })
        .from(s.timelines)
        .innerJoin(s.episodes, eq(s.timelines.episodeId, s.episodes.id))
        .where(inArray(s.episodes.projectId, ids)),
    )
    const takeIds =
      assetIds.length === 0
        ? []
        : await idsOf(db.select({ id: s.takes.id }).from(s.takes).where(inArray(s.takes.assetId, assetIds)))

    if (timelineIds.length > 0) {
      await db.delete(s.renderJobs).where(inArray(s.renderJobs.timelineId, timelineIds))
      await db.delete(s.timelineClips).where(inArray(s.timelineClips.timelineId, timelineIds))
    }
    if (takeIds.length > 0) await db.delete(s.takes).where(inArray(s.takes.id, takeIds))
  }
}
await db.delete(s.projects).where(eq(s.projects.title, DEMO_TITLE))

const [project] = await db
  .insert(s.projects)
  .values({
    title: DEMO_TITLE,
    synopsis: 'A werewolf heir returns to claim what betrayal took.',
    status: 'producing',
  })
  .returning()
if (!project) throw new Error('project 插入失败')

const [style] = await db
  .insert(s.styleProfiles)
  .values({
    projectId: project.id,
    name: 'Urban Noir Realism',
    description: 'cinematic, high contrast, cool shadows, shallow depth of field',
    negativePrompt: 'cartoon, illustration, watermark, text overlay',
  })
  .returning()
await db.update(s.projects).set({ styleProfileId: style?.id }).where(eq(s.projects.id, project.id))

const characters = await db
  .insert(s.characters)
  .values([
    {
      projectId: project.id,
      name: 'Lena',
      description: 'woman, 25, shoulder-length black hair, beige trench coat',
      anchorTokens: ['beige trench coat', 'silver crescent pendant'],
      prohibitedChanges: ['hair color', 'pendant'],
      voiceId: 'mock-female-warm-01',
    },
    {
      projectId: project.id,
      name: 'Marcus',
      description: 'man, 32, close-cropped beard, dark grey overcoat',
      anchorTokens: ['dark grey overcoat', 'scar above left brow'],
      prohibitedChanges: ['scar', 'beard length'],
      voiceId: 'mock-male-low-01',
    },
  ])
  .returning()

const locations = await db
  .insert(s.locations)
  .values([
    {
      projectId: project.id,
      name: 'Corner Cafe',
      description: 'small urban cafe, warm interior',
      interior: true,
    },
    {
      projectId: project.id,
      name: 'Rooftop',
      description: 'city rooftop at night, distant skyline',
      interior: false,
    },
  ])
  .returning()

const [episode] = await db
  .insert(s.episodes)
  .values({
    projectId: project.id,
    index: 1,
    title: 'The Return',
    logline: 'Lena walks back into the life that discarded her.',
    hook: 'She was declared dead three years ago. She just ordered coffee.',
    cliffhanger: 'Marcus recognises the pendant — and reaches for his phone.',
    targetDurationSec: 75,
    status: 'shotlisted',
  })
  .returning()
if (!episode) throw new Error('episode 插入失败')

const sceneRows = await db
  .insert(s.scenes)
  .values([
    {
      episodeId: episode.id,
      index: 1,
      locationId: locations[0]?.id,
      timeOfDay: 'day',
      summary: 'Lena enters the cafe.',
    },
    {
      episodeId: episode.id,
      index: 2,
      locationId: locations[0]?.id,
      timeOfDay: 'day',
      summary: 'Marcus notices her.',
    },
    {
      episodeId: episode.id,
      index: 3,
      locationId: locations[1]?.id,
      timeOfDay: 'night',
      summary: 'The rooftop confrontation.',
    },
  ])
  .returning()

/**
 * 12 镜分布到 3 场：4 / 4 / 4。景别有变化——连续三个同景别会被校验器标黄。
 *
 * `cast` 是**本镜真正出场的角色名**，不是「本项目有哪些角色」。此前每镜都写
 * `characterIds: characters.map(c => c.id)`，于是「咖啡馆门脸的远景」也会被
 * 注入 Lena 和 Marcus 的完整外观与视觉锚点。prompt-kit 把这一列接进 prompt
 * 之后，那就不再是一条无害的脏数据，而是每一镜都在往模型面前放两个不该在
 * 画面里的人。留空 = 空镜。
 */
const plan: Array<{
  scene: number
  shotType: s.ShotTypeCol
  action: string
  dialogue?: string
  cast?: readonly string[]
  dur: string
}> = [
  { scene: 0, shotType: 'establishing', action: 'the cafe front from across the wet street', dur: '4.0' },
  { scene: 0, shotType: 'ms', action: 'Lena pushes the door open, bell rings', cast: ['Lena'], dur: '3.0' },
  {
    scene: 0,
    shotType: 'cu',
    action: 'Lena scans the room, jaw tight',
    cast: ['Lena'],
    dialogue: 'Still the same chair.',
    dur: '4.0',
  },
  {
    scene: 0,
    shotType: 'ots',
    action: 'over Lena toward the barista counter',
    cast: ['Lena'],
    dialogue: 'Black. No sugar.',
    dur: '3.5',
  },
  {
    scene: 1,
    shotType: 'ws',
    action: 'Marcus alone at the corner table, papers spread',
    cast: ['Marcus'],
    dur: '4.0',
  },
  { scene: 1, shotType: 'cu', action: 'Marcus looks up, recognition landing', cast: ['Marcus'], dur: '3.0' },
  {
    scene: 1,
    shotType: 'ecu',
    action: 'the silver crescent pendant catching light',
    cast: ['Lena'],
    dur: '2.5',
  },
  {
    scene: 1,
    shotType: 'ms',
    action: 'Marcus stands, chair scraping back',
    cast: ['Marcus'],
    dialogue: 'You are supposed to be dead.',
    dur: '4.0',
  },
  { scene: 2, shotType: 'establishing', action: 'rooftop at night, city glow behind', dur: '4.0' },
  {
    scene: 2,
    shotType: 'ms',
    action: 'Lena steps to the ledge, wind in her coat',
    cast: ['Lena'],
    dur: '3.5',
  },
  {
    scene: 2,
    shotType: 'ots',
    action: 'over Marcus as he closes the distance',
    cast: ['Marcus', 'Lena'],
    dialogue: 'Who sent you back?',
    dur: '4.0',
  },
  {
    scene: 2,
    shotType: 'cu',
    // 原文是 `Lena answers without turning around`——`without` 命中
    // `shotlist.ts` 的 NEGATION 正则，也直接违反 system prompt 自己写的
    // 「只写正面描述、别写不存在的东西」。夹具进的是真实 prompt，不该带头违规
    action: 'Lena answers with her back still turned, chin lifted',
    cast: ['Lena'],
    dialogue: 'You did.',
    dur: '3.0',
  },
]

const byName = new Map(characters.map((c) => [c.name, c.id]))
/** 名字写错时立刻炸，不要静默塞一个空 uuid 进库 */
const castIds = (names: readonly string[] = []): string[] =>
  names.map((nm) => {
    const id = byName.get(nm)
    if (!id) throw new Error(`plan 里的角色名 ${nm} 不在 characters 里`)
    return id
  })

let n = 0
const shotRows = await db
  .insert(s.shots)
  .values(
    plan.map((p) => ({
      sceneId: sceneRows[p.scene]!.id,
      index: ++n,
      shotType: p.shotType,
      action: p.action,
      ...(p.dialogue ? { dialogue: p.dialogue } : {}),
      durationSec: p.dur,
      characterIds: castIds(p.cast),
      status: 'ready' as const,
    })),
  )
  .returning()

// 自检：幂等性是本文件声称的性质，就地验证而不是相信注释
const [check] = await db.select().from(s.projects).where(eq(s.projects.title, DEMO_TITLE))
const dupes = await db.select().from(s.projects).where(eq(s.projects.title, DEMO_TITLE))
if (dupes.length !== 1) throw new Error(`seed 不幂等：DEMO 项目有 ${dupes.length} 个，应为 1`)
if (!check?.styleProfileId) throw new Error('styleProfileId 未回填——update 的 where 条件没生效')

// 空镜不该有出场角色。prompt-kit 把 characterIds 接进 prompt 之后，
// 「每镜都塞全部角色」会让远景空镜也带上两个人的锚点——退化回去必须响
const emptyShots = shotRows.filter((r) => !plan[r.index - 1]?.cast)
if (emptyShots.length === 0) throw new Error('夹具里没有空镜了，这条自检失去意义')
for (const r of emptyShots) {
  if (r.characterIds.length > 0) {
    throw new Error(`第 ${r.index} 镜是空镜却写了 ${r.characterIds.length} 个出场角色`)
  }
}

await client.end()

const total = plan.reduce((a, p) => a + Number(p.dur), 0)
console.log(
  `✓ seed: 1 项目 / 1 集 / ${sceneRows.length} 场 / ${shotRows.length} 镜 / ${characters.length} 角色 / ${locations.length} 场景，本集 ${total} 秒`,
)
