import { eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../db/client.js'
import * as s from '../db/schema.js'
import { buildPrompt, type BuiltPrompt, type PromptCharacter } from './prompt.js'

/**
 * 「这一镜会发出去什么」——取数 + 拼装，一处实现。
 *
 * ## 为什么要抽出来
 *
 * 这段逻辑原来长在 `applyTransition.ts` 的 `enqueue.generation` 分支里。
 * `POST /api/ai/prompt-preview`（`06-api-spec.md:108`，设计了但一直没实现）要
 * 回答的是同一个问题——「**花钱之前先看清将要发出去的 prompt 长什么样**」。
 *
 * 预览另写一份取数逻辑，就是 PR-J 刚修掉的那类 bug 的翻版：两份会漂，而漂了
 * 之后**预览显示的东西和真实发出去的不是一回事**，那时它比没有预览更坏——
 * 人会照着一份假的去调措辞。
 *
 * 所以：一个函数，两个调用方。预览和真实生成走同一行代码。
 */

export interface ResolvedPrompt extends BuiltPrompt {
  /** true = 走了 `shots.prompt_override` 的人工旁路，没有经过拼装 */
  readonly overridden: boolean
  /** 拼装时实际取到的资产，供预览页解释「为什么长这样」 */
  readonly inputs: {
    readonly characters: readonly PromptCharacter[]
    readonly location: { description: string; interior: boolean; anchorTokens: readonly string[] } | null
    readonly style: { description: string; negativePrompt: string | null } | null
    readonly timeOfDay: string | null
  }
}

/**
 * @param tx 事务或库连接。真实生成路径在 `FOR UPDATE` 事务里调它，预览用普通连接
 * @returns shot 不存在时返回 null
 */
export async function resolvePrompt(tx: DbOrTx, shotId: string): Promise<ResolvedPrompt | null> {
  const [row] = await tx
    .select({
      shotType: s.shots.shotType,
      cameraMove: s.shots.cameraMove,
      action: s.shots.action,
      emotion: s.shots.emotion,
      characterIds: s.shots.characterIds,
      promptOverride: s.shots.promptOverride,
    })
    .from(s.shots)
    .where(eq(s.shots.id, shotId))
  if (!row) return null

  const [ctx] = await tx
    .select({
      timeOfDay: s.scenes.timeOfDay,
      locDescription: s.locations.description,
      locInterior: s.locations.interior,
      locAnchors: s.locations.anchorTokens,
      styleDescription: s.styleProfiles.description,
      styleNegative: s.styleProfiles.negativePrompt,
    })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .innerJoin(s.projects, eq(s.episodes.projectId, s.projects.id))
    .leftJoin(s.locations, eq(s.scenes.locationId, s.locations.id))
    // 风格要经 projects.style_profile_id 这一跳。不回填的话建了也进不来
    .leftJoin(s.styleProfiles, eq(s.projects.styleProfileId, s.styleProfiles.id))
    .where(eq(s.shots.id, shotId))

  // 本镜出场的角色。锚点是跨镜头一致性的载体（ADR-0008）——同一个角色每一镜都
  // 带着同一串视觉锚点进 prompt，模型才有机会画成同一个人
  const characters: PromptCharacter[] =
    row.characterIds.length === 0
      ? []
      : await tx
          .select({
            name: s.characters.name,
            description: s.characters.description,
            anchorTokens: s.characters.anchorTokens,
          })
          .from(s.characters)
          .where(inArray(s.characters.id, row.characterIds))

  const location =
    ctx?.locDescription === undefined || ctx.locDescription === null
      ? null
      : {
          description: ctx.locDescription,
          interior: ctx.locInterior ?? true,
          anchorTokens: ctx.locAnchors ?? [],
        }

  const style =
    ctx?.styleDescription === undefined || ctx.styleDescription === null
      ? null
      : { description: ctx.styleDescription, negativePrompt: ctx.styleNegative }

  const inputs = { characters, location, style, timeOfDay: ctx?.timeOfDay ?? null }

  // promptOverride 是人工旁路：写了就原样用，不再拼装（当前无写入方）
  if (row.promptOverride)
    return {
      prompt: row.promptOverride,
      negativePrompt: style?.negativePrompt ?? null,
      overridden: true,
      inputs,
    }

  const built = buildPrompt(
    {
      shotType: row.shotType,
      action: row.action,
      cameraMove: row.cameraMove,
      emotion: row.emotion,
      timeOfDay: ctx?.timeOfDay ?? null,
    },
    { characters, location, style },
  )
  return { ...built, overridden: false, inputs }
}
