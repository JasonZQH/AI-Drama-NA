import { eq } from 'drizzle-orm'
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

const DEMO_TITLE = 'DEMO · Ashes of the Alpha'

const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL 未设置')

const { db, client } = createDb(url, 1)

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

/** 12 镜分布到 3 场：4 / 4 / 4。景别有变化——连续三个同景别会被校验器标黄 */
const plan: Array<{
  scene: number
  shotType: s.ShotTypeCol
  action: string
  dialogue?: string
  dur: string
}> = [
  { scene: 0, shotType: 'establishing', action: 'the cafe front from across the wet street', dur: '4.0' },
  { scene: 0, shotType: 'ms', action: 'Lena pushes the door open, bell rings', dur: '3.0' },
  {
    scene: 0,
    shotType: 'cu',
    action: 'Lena scans the room, jaw tight',
    dialogue: 'Still the same chair.',
    dur: '4.0',
  },
  {
    scene: 0,
    shotType: 'ots',
    action: 'over Lena toward the barista counter',
    dialogue: 'Black. No sugar.',
    dur: '3.5',
  },
  { scene: 1, shotType: 'ws', action: 'Marcus alone at the corner table, papers spread', dur: '4.0' },
  { scene: 1, shotType: 'cu', action: 'Marcus looks up, recognition landing', dur: '3.0' },
  { scene: 1, shotType: 'ecu', action: 'the silver crescent pendant catching light', dur: '2.5' },
  {
    scene: 1,
    shotType: 'ms',
    action: 'Marcus stands, chair scraping back',
    dialogue: 'You are supposed to be dead.',
    dur: '4.0',
  },
  { scene: 2, shotType: 'establishing', action: 'rooftop at night, city glow behind', dur: '4.0' },
  { scene: 2, shotType: 'ms', action: 'Lena steps to the ledge, wind in her coat', dur: '3.5' },
  {
    scene: 2,
    shotType: 'ots',
    action: 'over Marcus as he closes the distance',
    dialogue: 'Who sent you back?',
    dur: '4.0',
  },
  {
    scene: 2,
    shotType: 'cu',
    action: 'Lena answers without turning around',
    dialogue: 'You did.',
    dur: '3.0',
  },
]

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
      characterIds: characters.map((c) => c.id),
      status: 'ready' as const,
    })),
  )
  .returning()

// 自检：幂等性是本文件声称的性质，就地验证而不是相信注释
const [check] = await db.select().from(s.projects).where(eq(s.projects.title, DEMO_TITLE))
const dupes = await db.select().from(s.projects).where(eq(s.projects.title, DEMO_TITLE))
if (dupes.length !== 1) throw new Error(`seed 不幂等：DEMO 项目有 ${dupes.length} 个，应为 1`)
if (!check?.styleProfileId) throw new Error('styleProfileId 未回填——update 的 where 条件没生效')

await client.end()

const total = plan.reduce((a, p) => a + Number(p.dur), 0)
console.log(
  `✓ seed: 1 项目 / 1 集 / ${sceneRows.length} 场 / ${shotRows.length} 镜 / ${characters.length} 角色 / ${locations.length} 场景，本集 ${total} 秒`,
)
