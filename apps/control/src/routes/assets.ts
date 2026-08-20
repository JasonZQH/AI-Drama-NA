import { Outfit } from '@ai-drama/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { ApiError } from './errors.js'

/**
 * 一致性资产的写入路径（PR-G）。
 *
 * 在这之前 `characters` / `locations` / `style_profiles` **三张表的唯一写入方
 * 都是 `db/seed.ts`**，资产页页头写着「本轮只读」——0 个按钮、0 个输入框。
 * 于是「调提示词」这件事在面板上根本做不到，尽管这三张表的内容正是每一条
 * prompt 的主体。
 *
 * ## 只开真正进 prompt 的字段
 *
 * `buildPrompt` 实际读的就这些：
 *
 * | 表 | 进 prompt 的列 |
 * |---|---|
 * | characters | `name` · `description` · `anchor_tokens` |
 * | locations | `name` · `description` * `interior` · `anchor_tokens` |
 * | style_profiles | `name` · `description` · `negative_prompt` |
 *
 * 另外开两个**尚无读取方但有确定消费者**的：`characters.voice_id`（M3 的 TTS，
 * 而 `lintShotlist` 的 E4 规则整条的理由就是它）与 `wardrobe`（PR-L 会让
 * `scenes.state_in` 挑它）。
 *
 * **不开**的：`face_set` / `body_ref` / `reference_asset_ids` / `platform_bindings`
 * / `lora_asset_id` —— 它们是图片资产的引用，而「要不要参考图、要几张、怎么绑」
 * 是 P6 的 U1–U3 要买的答案。现在给它们做表单是在流沙上盖楼。
 * `prohibited_changes` 也不开：存的是维度名不是值，而那些值已经在
 * `description` / `anchor_tokens` 里了。
 *
 * ## 删除：三处引用都**没有外键**
 *
 * `scenes.location_id`、`projects.style_profile_id`、`shots.character_ids[]`
 * 全是裸 uuid，删掉被引用的资产不会报错，只会留下一个查不到的 id——而
 * `resolvePrompt` 的 leftJoin 会安静地返回 null，表现为**prompt 里那一路资产
 * 突然消失**，没有任何一处告诉你为什么。所以每个 DELETE 自己查引用。
 */

const uuidParam = z.object({ id: z.string().uuid() })

/** 逗号或换行分隔 → 去空去重。锚点是人一行一个敲进来的，不该逼他写 JSON 数组 */
const tokens = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined
    const raw = Array.isArray(v) ? v : v.split(/[,\n]/)
    return [...new Set(raw.map((x) => x.trim()).filter((x) => x !== ''))]
  })

const characterBody = z.object({
  name: z.string().trim().min(1, '角色要有名字').optional(),
  description: z.string().trim().optional(),
  anchorTokens: tokens,
  voiceId: z.string().trim().nullish(),
  wardrobe: z.array(Outfit).optional(),
})

const locationBody = z.object({
  name: z.string().trim().min(1, '地点要有名字').optional(),
  description: z.string().trim().optional(),
  interior: z.boolean().optional(),
  anchorTokens: tokens,
})

const styleBody = z.object({
  name: z.string().trim().min(1, '风格要有名字').optional(),
  description: z.string().trim().optional(),
  negativePrompt: z.string().trim().nullish(),
})

/*
 * 这里曾经有一个 `pick()`，用来「只把显式给出的键放进 patch」。它有两个问题：
 * zod 对缺席的可选字段根本不会输出键（实测 `parse({})` → `{}`、
 * `parse({name:'a'})` → `['name']`，带 `.transform()` 的字段也一样），所以
 * `Object.entries(body)` 本来就只有人真的传了的那些。
 *
 * 变异测试把它换成不过滤的版本之后一条用例都没红——PR-E 那个
 * `delete env[OPENROUTER_API_KEY]` 是同一类。带着漂亮注释的死代码比没有注释更坏，
 * 因为注释在描述一个不存在的行为。
 *
 * **② 更糟的是它在悄悄放宽类型。** 它的返回类型是 `Record<string, unknown>`，
 * drizzle 的 `.set()` 于是收下了本该报错的形状。删掉它之后 typecheck 立刻在三处
 * 报错——那三处一直是靠这个 widener 蒙混过关的。
 *
 * 换成本仓已有的显式 spread 惯用法（`routes/api.ts` 的 PATCH episode 就是这么
 * 写的）：多几行，但每个字段的取舍都摆在明处，且全程有类型。
 */

export function registerAssets(app: FastifyInstance, db: Db): void {
  const project = async (id: string): Promise<void> => {
    const [p] = await db.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.id, id))
    if (!p) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)
  }

  // ── 角色 ────────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/characters', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    await project(id)
    const b = characterBody.parse(req.body ?? {})
    if (!b.name) throw new ApiError('VALIDATION_FAILED', '角色要有名字')
    /*
     * 名字在分镜那一步会被灌成 `z.enum`（模型编不出不存在的角色），落库时又靠它
     * 反查 id。同名两个角色会让 `byName` 取到哪一个变成运气。
     */
    const [dupe] = await db
      .select({ id: s.characters.id })
      .from(s.characters)
      .where(sql`${s.characters.projectId} = ${id} and ${s.characters.name} = ${b.name}`)
    if (dupe)
      throw new ApiError(
        'CONFLICT',
        `这个项目里已经有叫「${b.name}」的角色了。分镜按名字反查 id，重名会让取到哪一个变成运气。`,
      )

    const [row] = await db
      .insert(s.characters)
      .values({
        projectId: id,
        name: b.name,
        description: b.description ?? '',
        ...(b.anchorTokens === undefined ? {} : { anchorTokens: b.anchorTokens }),
        ...(b.voiceId ? { voiceId: b.voiceId } : {}),
        ...(b.wardrobe === undefined ? {} : { wardrobe: b.wardrobe }),
      })
      .returning()
    return reply.status(201).send({ character: row })
  })

  app.patch('/api/characters/:id', async (req) => {
    const { id } = uuidParam.parse(req.params)
    const b = characterBody.parse(req.body ?? {})
    const patch = {
      ...(b.name === undefined ? {} : { name: b.name }),
      ...(b.description === undefined ? {} : { description: b.description }),
      ...(b.anchorTokens === undefined ? {} : { anchorTokens: b.anchorTokens }),
      ...(b.voiceId === undefined ? {} : { voiceId: b.voiceId ?? null }),
      ...(b.wardrobe === undefined ? {} : { wardrobe: b.wardrobe }),
    }
    const [row] = Object.keys(patch).length
      ? await db.update(s.characters).set(patch).where(eq(s.characters.id, id)).returning()
      : await db.select().from(s.characters).where(eq(s.characters.id, id))
    if (!row) throw new ApiError('NOT_FOUND', `character ${id} 不存在`)
    return { character: row }
  })

  app.delete('/api/characters/:id', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    /*
     * `shots.character_ids` 是 uuid[] 且**没有外键**。删掉之后那个 id 还留在
     * 数组里，`resolvePrompt` 的 inArray 查不到它，表现为**这一镜的角色从
     * prompt 里静默消失**——没有任何一处告诉你为什么。
     */
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.shots)
      .where(sql`${id}::uuid = any(${s.shots.characterIds})`)
    if ((used?.n ?? 0) > 0)
      throw new ApiError(
        'CONFLICT',
        `还有 ${used?.n} 个镜头把这个角色列在 characterIds 里。直接删会在那些镜头里留下一个查不到的 id，而 prompt 会安静地少掉这个角色。先把它从那些镜头上摘掉。`,
        { shots: used?.n },
      )
    const [row] = await db
      .delete(s.characters)
      .where(eq(s.characters.id, id))
      .returning({ id: s.characters.id })
    if (!row) throw new ApiError('NOT_FOUND', `character ${id} 不存在`)
    return reply.status(204).send()
  })

  // ── 地点 ────────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/locations', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    await project(id)
    const b = locationBody.parse(req.body ?? {})
    if (!b.name) throw new ApiError('VALIDATION_FAILED', '地点要有名字')
    const [row] = await db
      .insert(s.locations)
      .values({
        projectId: id,
        name: b.name,
        description: b.description ?? '',
        ...(b.interior === undefined ? {} : { interior: b.interior }),
        ...(b.anchorTokens === undefined ? {} : { anchorTokens: b.anchorTokens }),
      })
      .returning()
    return reply.status(201).send({ location: row })
  })

  app.patch('/api/locations/:id', async (req) => {
    const { id } = uuidParam.parse(req.params)
    const b = locationBody.parse(req.body ?? {})
    const patch = {
      ...(b.name === undefined ? {} : { name: b.name }),
      ...(b.description === undefined ? {} : { description: b.description }),
      ...(b.interior === undefined ? {} : { interior: b.interior }),
      ...(b.anchorTokens === undefined ? {} : { anchorTokens: b.anchorTokens }),
    }
    const [row] = Object.keys(patch).length
      ? await db.update(s.locations).set(patch).where(eq(s.locations.id, id)).returning()
      : await db.select().from(s.locations).where(eq(s.locations.id, id))
    if (!row) throw new ApiError('NOT_FOUND', `location ${id} 不存在`)
    return { location: row }
  })

  app.delete('/api/locations/:id', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    // `scenes.location_id` 无外键，删了会让那些场次的 prompt 少掉整个环境描述
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.scenes)
      .where(eq(s.scenes.locationId, id))
    if ((used?.n ?? 0) > 0)
      throw new ApiError(
        'CONFLICT',
        `还有 ${used?.n} 个场次挂着这个地点。直接删会让那些场次的每一条 prompt 都少掉环境描述，而且看不出是为什么。先把那些场次改挂到别的地点。`,
        { scenes: used?.n },
      )
    const [row] = await db.delete(s.locations).where(eq(s.locations.id, id)).returning({ id: s.locations.id })
    if (!row) throw new ApiError('NOT_FOUND', `location ${id} 不存在`)
    return reply.status(204).send()
  })

  // ── 风格 ────────────────────────────────────────────────────────────────

  /**
   * 建风格时**如果项目还没挂风格，自动挂上**。
   *
   * 风格要经 `projects.style_profile_id` 那一跳才进 prompt，这是最容易漏的一步
   * ——`seed.ts` 也是用第二条 UPDATE 补的。建了不挂等于白建，而"建完还要再点
   * 一下设为当前"是纯摩擦。已经挂了别的就不动，那是人的选择。
   */
  app.post('/api/projects/:id/styles', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    await project(id)
    const b = styleBody.parse(req.body ?? {})
    if (!b.name) throw new ApiError('VALIDATION_FAILED', '风格要有名字')

    const [row] = await db
      .insert(s.styleProfiles)
      .values({
        projectId: id,
        name: b.name,
        description: b.description ?? '',
        ...(b.negativePrompt ? { negativePrompt: b.negativePrompt } : {}),
      })
      .returning()

    const [proj] = await db
      .select({ styleProfileId: s.projects.styleProfileId })
      .from(s.projects)
      .where(eq(s.projects.id, id))
    const attached = !proj?.styleProfileId
    if (attached) await db.update(s.projects).set({ styleProfileId: row!.id }).where(eq(s.projects.id, id))

    return reply.status(201).send({ style: row, attached })
  })

  app.patch('/api/styles/:id', async (req) => {
    const { id } = uuidParam.parse(req.params)
    const b = styleBody.parse(req.body ?? {})
    const patch = {
      ...(b.name === undefined ? {} : { name: b.name }),
      ...(b.description === undefined ? {} : { description: b.description }),
      ...(b.negativePrompt === undefined ? {} : { negativePrompt: b.negativePrompt ?? null }),
    }
    const [row] = Object.keys(patch).length
      ? await db.update(s.styleProfiles).set(patch).where(eq(s.styleProfiles.id, id)).returning()
      : await db.select().from(s.styleProfiles).where(eq(s.styleProfiles.id, id))
    if (!row) throw new ApiError('NOT_FOUND', `style ${id} 不存在`)
    return { style: row }
  })

  app.delete('/api/styles/:id', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    // `projects.style_profile_id` 无外键。删了之后 leftJoin 静默返回 null，
    // 表现为**每一条 prompt 都少掉风格那一句**
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.projects)
      .where(eq(s.projects.styleProfileId, id))
    if ((used?.n ?? 0) > 0)
      throw new ApiError(
        'CONFLICT',
        '这个风格正被项目使用中。直接删会让每一条 prompt 都少掉风格那一句，而且看不出是为什么。先把项目切到别的风格。',
      )
    const [row] = await db
      .delete(s.styleProfiles)
      .where(eq(s.styleProfiles.id, id))
      .returning({ id: s.styleProfiles.id })
    if (!row) throw new ApiError('NOT_FOUND', `style ${id} 不存在`)
    return reply.status(204).send()
  })
}
