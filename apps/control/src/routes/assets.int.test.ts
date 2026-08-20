import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../db/client.js'
import * as s from '../db/schema.js'
import { MockProvider } from '../providers/mock.js'
import { createConnection, createQueues } from '../queue/queues.js'
import { buildServer } from '../server.js'
import { Storage, storageFromEnv } from '../storage/s3.js'
import { resolvePrompt } from '../pipeline/resolvePrompt.js'

/**
 * 一致性资产的写入路径（PR-G）。
 *
 * 自建项目，不借 seed 的那个——这一组要删东西，而 seed 的项目是别的文件的夹具。
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://drama:drama@localhost:5432/drama'
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const { db, client } = createDb(DB_URL, 3)
const queues = createQueues({ url: REDIS_URL })
const storage = new Storage(
  storageFromEnv({
    S3_BUCKET: 'drama',
    S3_INTERNAL_ENDPOINT: process.env['S3_INTERNAL_ENDPOINT'] ?? 'http://localhost:9000',
    S3_ACCESS_KEY: 'adminlocal',
    S3_SECRET_KEY: 'adminlocal123',
  }),
)
const TEST_API_KEY = 'test-key'
const H = { 'x-api-key': TEST_API_KEY }

let app: FastifyInstance
let projectId = ''

const write = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: H, ...(payload ? { payload } : {}) })

beforeAll(async () => {
  process.env['LOG_LEVEL'] = 'silent'
  app = buildServer({
    db,
    queues,
    storage,
    providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
    maxAttempts: 4,
    media: { render: () => Promise.reject(new Error('未配置')) },
    healthProbe: () => client`SELECT 1`,
    makeSubscriber: () => createConnection(REDIS_URL),
    apiKey: TEST_API_KEY,
  })
  await app.ready()
  const [p] = await db.insert(s.projects).values({ title: '资产用例' }).returning()
  projectId = p!.id
})

afterAll(async () => {
  await db.delete(s.projects).where(eq(s.projects.id, projectId))
})

describe('角色', () => {
  it('建 → 读回 → 改，锚点接受逗号/换行分隔', async () => {
    const r = await write('POST', `/api/projects/${projectId}/characters`, {
      name: 'Nadia',
      description: 'woman, 30, cropped silver hair',
      anchorTokens: 'silver hair, jade ring\n leather cuff , silver hair',
      voiceId: 'mock-female-01',
    })
    expect(r.statusCode).toBe(201)
    const c = (r.json() as { character: { id: string; anchorTokens: string[] } }).character
    // 去空 + 去重 + trim。人是一行一个敲进来的，不该逼他写 JSON 数组
    expect(c.anchorTokens).toEqual(['silver hair', 'jade ring', 'leather cuff'])

    await write('PATCH', `/api/characters/${c.id}`, { description: '改过的描述' })
    const [row] = await db.select().from(s.characters).where(eq(s.characters.id, c.id))
    expect(row!.description).toBe('改过的描述')
    expect(row!.name, '没传的字段不该被动').toBe('Nadia')
    await write('DELETE', `/api/characters/${c.id}`)
  })

  /**
   * 名字在分镜那一步被灌成 `z.enum`，落库时又靠它反查 id。同名会让 `byName`
   * 取到哪一个变成运气。
   */
  it('同项目内重名拒收', async () => {
    const a = await write('POST', `/api/projects/${projectId}/characters`, { name: 'Dup' })
    const b = await write('POST', `/api/projects/${projectId}/characters`, { name: 'Dup' })
    expect(b.statusCode).toBe(409)
    expect((b.json() as { error: { message: string } }).error.message).toMatch(/运气/)
    await write('DELETE', `/api/characters/${(a.json() as { character: { id: string } }).character.id}`)
  })

  it('没名字拒收', async () => {
    expect((await write('POST', `/api/projects/${projectId}/characters`, { name: '  ' })).statusCode).toBe(
      422,
    )
  })

  /**
   * **`shots.character_ids` 是 uuid[] 且没有外键。**
   * 删掉之后那个 id 还留在数组里，`resolvePrompt` 的 inArray 查不到它，
   * 表现为这一镜的角色从 prompt 里**静默消失**。
   */
  it('被镜头引用时拒绝删，且报错说清后果', async () => {
    const c = (
      (await write('POST', `/api/projects/${projectId}/characters`, { name: 'Used' })).json() as {
        character: { id: string }
      }
    ).character
    const [ep] = await db.insert(s.episodes).values({ projectId, index: 1 }).returning()
    const [sc] = await db.insert(s.scenes).values({ episodeId: ep!.id, index: 1 }).returning()
    const [shot] = await db
      .insert(s.shots)
      .values({ sceneId: sc!.id, index: 1, shotType: 'ms', action: 'x', characterIds: [c.id] })
      .returning()

    const bad = await write('DELETE', `/api/characters/${c.id}`)
    expect(bad.statusCode).toBe(409)
    expect((bad.json() as { error: { message: string } }).error.message).toMatch(/1 个镜头/)
    expect(await db.select().from(s.characters).where(eq(s.characters.id, c.id))).toHaveLength(1)

    // 从镜头上摘掉之后就删得了
    await db.update(s.shots).set({ characterIds: [] }).where(eq(s.shots.id, shot!.id))
    expect((await write('DELETE', `/api/characters/${c.id}`)).statusCode).toBe(204)
    await db.delete(s.episodes).where(eq(s.episodes.id, ep!.id))
  })

  /** 服装先于参考图存在（与 `face_set` 可空同一个理由）。文本那一半现在就生效 */
  it('wardrobe 可以只有文字，没有图', async () => {
    const r = await write('POST', `/api/projects/${projectId}/characters`, {
      name: 'Wardrobed',
      wardrobe: [
        { id: 'pajama', name: '睡衣版', description: 'grey flannel pajamas, bare feet' },
        { id: 'work', name: '工作版', description: 'charcoal blazer, white shirt' },
      ],
    })
    expect(r.statusCode).toBe(201)
    const c = (r.json() as { character: { id: string; wardrobe: { id: string; description: string }[] } })
      .character
    expect(c.wardrobe).toHaveLength(2)
    expect(c.wardrobe[0]!.description).toBe('grey flannel pajamas, bare feet')
    await write('DELETE', `/api/characters/${c.id}`)
  })
})

describe('地点', () => {
  it('建 → 改 → 删', async () => {
    const r = await write('POST', `/api/projects/${projectId}/locations`, {
      name: 'Loading Bay',
      description: 'concrete dock, sodium lamps',
      interior: false,
      anchorTokens: ['sodium lamps'],
    })
    expect(r.statusCode).toBe(201)
    const l = (r.json() as { location: { id: string; interior: boolean } }).location
    expect(l.interior).toBe(false)
    await write('PATCH', `/api/locations/${l.id}`, { interior: true })
    const [row] = await db.select().from(s.locations).where(eq(s.locations.id, l.id))
    expect(row!.interior).toBe(true)
    expect((await write('DELETE', `/api/locations/${l.id}`)).statusCode).toBe(204)
  })

  /** `scenes.location_id` 无外键——删了那些场次的 prompt 会少掉整个环境描述 */
  it('被场次挂着时拒绝删', async () => {
    const l = (
      (await write('POST', `/api/projects/${projectId}/locations`, { name: 'Attached' })).json() as {
        location: { id: string }
      }
    ).location
    const [ep] = await db.insert(s.episodes).values({ projectId, index: 2 }).returning()
    await db.insert(s.scenes).values({ episodeId: ep!.id, index: 1, locationId: l.id })

    const bad = await write('DELETE', `/api/locations/${l.id}`)
    expect(bad.statusCode).toBe(409)
    expect((bad.json() as { error: { message: string } }).error.message).toMatch(/1 个场次/)
    await db.delete(s.episodes).where(eq(s.episodes.id, ep!.id))
    expect((await write('DELETE', `/api/locations/${l.id}`)).statusCode).toBe(204)
  })
})

describe('风格', () => {
  /**
   * 风格要经 `projects.style_profile_id` 那一跳才进 prompt，这是最容易漏的一步
   * ——`seed.ts` 也是用第二条 UPDATE 补的。建了不挂等于白建。
   */
  it('项目还没挂风格时，建完自动挂上', async () => {
    const r = await write('POST', `/api/projects/${projectId}/styles`, {
      name: 'Bleach Bypass',
      description: 'desaturated, crushed blacks',
      negativePrompt: 'cartoon, watermark',
    })
    expect(r.statusCode).toBe(201)
    const b = r.json() as { style: { id: string }; attached: boolean }
    expect(b.attached, '第一个风格该自动挂上').toBe(true)
    const [proj] = await db.select().from(s.projects).where(eq(s.projects.id, projectId))
    expect(proj!.styleProfileId).toBe(b.style.id)

    // 已经挂了别的就不动——那是人的选择
    const second = await write('POST', `/api/projects/${projectId}/styles`, { name: 'Second' })
    expect((second.json() as { attached: boolean }).attached).toBe(false)
    const [after] = await db.select().from(s.projects).where(eq(s.projects.id, projectId))
    expect(after!.styleProfileId).toBe(b.style.id)

    await write('DELETE', `/api/styles/${(second.json() as { style: { id: string } }).style.id}`)
  })

  it('正在用的风格拒绝删', async () => {
    const [proj] = await db.select().from(s.projects).where(eq(s.projects.id, projectId))
    const inUse = proj!.styleProfileId!
    const bad = await write('DELETE', `/api/styles/${inUse}`)
    expect(bad.statusCode).toBe(409)
    expect((bad.json() as { error: { message: string } }).error.message).toMatch(/风格那一句/)
  })

  /** 改完要真的影响 prompt——否则这一整组端点是白做的 */
  it('改风格描述会直接改变下一次发出去的 prompt', async () => {
    const [ep] = await db.insert(s.episodes).values({ projectId, index: 3 }).returning()
    const [sc] = await db.insert(s.scenes).values({ episodeId: ep!.id, index: 1 }).returning()
    const [shot] = await db
      .insert(s.shots)
      .values({ sceneId: sc!.id, index: 1, shotType: 'ms', action: 'she turns' })
      .returning()
    try {
      const before = await resolvePrompt(db, shot!.id)
      expect(before!.prompt).toContain('desaturated, crushed blacks')

      const [proj] = await db.select().from(s.projects).where(eq(s.projects.id, projectId))
      await write('PATCH', `/api/styles/${proj!.styleProfileId}`, { description: 'high key, pastel' })

      const after = await resolvePrompt(db, shot!.id)
      expect(after!.prompt, '改了风格但 prompt 没变——这一组端点就是白做的').toContain('high key, pastel')
      expect(after!.prompt).not.toContain('desaturated')
    } finally {
      await db.delete(s.episodes).where(eq(s.episodes.id, ep!.id))
    }
  })
})

/**
 * 空 body 的 PATCH 是合法 no-op——PATCH 的语义就是「改我给的这些」，一个都没给
 * 就什么都不改。走 UPDATE 分支的话 drizzle 会因为「没有要设的值」直接抛。
 */
describe('空 PATCH 是 no-op，不是 500', () => {
  it('三类资产都一样', async () => {
    const c = (
      (
        await write('POST', `/api/projects/${projectId}/characters`, {
          name: 'NoopTarget',
          description: '原描述',
        })
      ).json() as { character: { id: string } }
    ).character
    const l = (
      (await write('POST', `/api/projects/${projectId}/locations`, { name: 'NoopLoc' })).json() as {
        location: { id: string }
      }
    ).location
    const st = (
      (await write('POST', `/api/projects/${projectId}/styles`, { name: 'NoopStyle' })).json() as {
        style: { id: string }
      }
    ).style
    try {
      for (const url of [`/api/characters/${c.id}`, `/api/locations/${l.id}`, `/api/styles/${st.id}`]) {
        const r = await write('PATCH', url, {})
        expect(r.statusCode, `${url} 的空 PATCH 该是 200 no-op`).toBe(200)
      }
      const [row] = await db.select().from(s.characters).where(eq(s.characters.id, c.id))
      expect(row!.description, '空 PATCH 不该动任何字段').toBe('原描述')
      expect(row!.name).toBe('NoopTarget')
    } finally {
      await write('DELETE', `/api/characters/${c.id}`)
      await write('DELETE', `/api/locations/${l.id}`)
      await write('DELETE', `/api/styles/${st.id}`)
    }
  })

  it('不存在的资源回 404 而不是静默成功', async () => {
    const nil = '00000000-0000-4000-8000-000000000000'
    for (const url of [`/api/characters/${nil}`, `/api/locations/${nil}`, `/api/styles/${nil}`]) {
      expect((await write('PATCH', url, { name: 'x' })).statusCode, url).toBe(404)
      expect((await write('PATCH', url, {})).statusCode, `${url} 空 PATCH`).toBe(404)
    }
  })
})

describe('写路径闸门', () => {
  it('没有 x-api-key 一律 401', async () => {
    for (const [method, url] of [
      ['POST', `/api/projects/${projectId}/characters`],
      ['POST', `/api/projects/${projectId}/locations`],
      ['POST', `/api/projects/${projectId}/styles`],
      ['DELETE', '/api/characters/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      const r = await app.inject({ method, url, payload: { name: 'x' } })
      expect(r.statusCode, `${method} ${url} 没有闸门`).toBe(401)
    }
  })

  it('不存在的 project 回 404，不建一行孤儿', async () => {
    const r = await write('POST', `/api/projects/00000000-0000-4000-8000-000000000000/characters`, {
      name: 'Orphan',
    })
    expect(r.statusCode).toBe(404)
  })
})
