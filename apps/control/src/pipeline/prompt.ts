import type { CameraMove, ShotType, TimeOfDay } from '@ai-drama/contracts'

/**
 * Shot Intent + 三路一致性资产 → provider 吃的 prompt。
 *
 * **纯函数，零 IO。** 数据由 `applyTransition` 在事务里查好传进来。
 *
 * ## 为什么这一层必须存在，而且必须在控制面
 *
 * Intent 是叙事的（「Lena 扫视房间，下颌绷紧」），prompt 是 provider 相关的
 * （Wan 与 Kling 吃的提示词结构不同）。分开之后换 provider 只需换这个函数，
 * 剧本层一个字不用改——这是 04-provider-adapter.md 能成立的前提（02 §3.2）。
 *
 * 有人会问：ComfyUI 的工作流里就能写提示词，为什么不放那儿？因为放那儿之后，
 * 同一个镜头在云 API 和自部署上的 prompt 就不一样了，而 ADR-0002 的整个立论
 * 是「两条路径要产生结构相同的记账数据才能比较」——prompt 不同，比较不成立。
 *
 * ## 它不是模板引擎
 *
 * 文档把这块叫「prompt-kit 模板引擎」（01 §3）。实际需要的就是按固定顺序拼一
 * 句话。没有 DSL、没有可配置模板表、没有注册表——要改措辞就改这个函数，一次
 * 提交，单测跟着跑。真到了需要非工程师频繁调措辞那天再谈配置面。
 */

/** 景别缩写对模型没有意义，要展开成人话 */
const SHOT_TYPE_PROSE: Record<ShotType, string> = {
  establishing: 'establishing shot',
  ws: 'wide shot',
  ms: 'medium shot',
  cu: 'close-up',
  ecu: 'extreme close-up',
  ots: 'over-the-shoulder shot',
  pov: 'point-of-view shot',
}

const CAMERA_MOVE_PROSE: Record<CameraMove, string> = {
  static: 'static camera',
  pan: 'camera pans',
  tilt: 'camera tilts',
  dolly: 'dolly move',
  orbit: 'camera orbits',
  handheld: 'handheld camera',
}

const TIME_OF_DAY_PROSE: Record<TimeOfDay, string> = {
  day: 'daytime',
  night: 'night',
  dawn: 'dawn light',
  dusk: 'dusk light',
}

export interface PromptCharacter {
  readonly name: string
  readonly description: string
  readonly anchorTokens: readonly string[]
}

export interface PromptLocation {
  readonly description: string
  readonly interior: boolean
  readonly anchorTokens: readonly string[]
}

export interface PromptStyle {
  readonly description: string
  readonly negativePrompt: string | null
}

/** 镜头的结构化意图。字段名与 `shots` 表一致 */
export interface PromptIntent {
  readonly shotType: ShotType
  readonly action: string
  readonly cameraMove: CameraMove | null
  readonly emotion: string | null
  /** 场景级，来自 `scenes.time_of_day` */
  readonly timeOfDay: TimeOfDay | null
}

export interface PromptAssets {
  /** 本镜出场的角色。空数组是合法的——空镜、大远景本来就没人 */
  readonly characters: readonly PromptCharacter[]
  readonly location: PromptLocation | null
  readonly style: PromptStyle | null
}

export interface BuiltPrompt {
  readonly prompt: string
  /** 来自 style_profiles。OpenRouter 的请求体没有这个字段，适配器忽略即可；
   *  ComfyUI 体系里负向词有效（M2）。列已存在，写它不花钱 */
  readonly negativePrompt: string | null
}

/** 去重且保序 */
function dedupe(parts: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const k = p.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p.trim())
  }
  return out
}

/**
 * 特征表去重。
 *
 * `description` 与 `anchorTokens` **都是逗号分隔的特征表**，且内容常常重叠
 * （seed 里 Lena 的 description 结尾就是 "beige trench coat"，而它同时也是
 * 一个锚点）。整串比较去不掉，会拼出「beige trench coat, beige trench coat」
 * ——运营在 ShotDrawer 里读到这个只会以为系统坏了。
 *
 * 先按逗号切开再精确去重，而不是做子串匹配：子串会把 "scar" 当成 "scarf"
 * 的重复给吃掉，而锚点里出现这种短词是常态。
 */
function traits(parts: readonly string[]): string[] {
  return dedupe(parts.flatMap((p) => p.split(',')))
}

function characterClause(c: PromptCharacter): string {
  // 锚点是「跨镜头一致性」的载体（ADR-0008）：同一个角色在每一镜都带着同一串
  // 视觉锚点进 prompt，模型才有机会画成同一个人
  return `${c.name}: ${traits([c.description, ...c.anchorTokens]).join(', ')}`
}

/**
 * 拼 prompt。分句而不是逗号串成一长条——每个从句独立可读，
 * 也让「这一镜为什么长这样」在 ShotDrawer 里一眼能看懂。
 *
 * 顺序：景别与运镜 → 动作 → 角色 → 地点 → 时间 → 风格。
 * 主体信息在前，修饰在后。
 *
 * **不放 dialogue。** 它驱动 TTS（schema 的注释就是这么写的），而把带引号的
 * 台词塞进视频 prompt 会诱导模型把字render 进画面——style_profiles 的负向词
 * 里「text overlay」正是在防这个。
 */
export function buildPrompt(intent: PromptIntent, assets: PromptAssets): BuiltPrompt {
  const framing = dedupe([
    SHOT_TYPE_PROSE[intent.shotType],
    ...(intent.cameraMove ? [CAMERA_MOVE_PROSE[intent.cameraMove]] : []),
  ]).join(', ')

  const action = dedupe([intent.action, ...(intent.emotion ? [intent.emotion] : [])]).join(', ')

  const sentences = [
    framing,
    action,
    ...assets.characters.map(characterClause),
    ...(assets.location
      ? [
          `${assets.location.interior ? 'Interior' : 'Exterior'}: ${traits([
            assets.location.description,
            ...assets.location.anchorTokens,
          ]).join(', ')}`,
        ]
      : []),
    ...(intent.timeOfDay ? [TIME_OF_DAY_PROSE[intent.timeOfDay]] : []),
    ...(assets.style ? [`Style: ${assets.style.description}`] : []),
  ]

  return {
    prompt: sentences.filter((s) => s.length > 0).join('. ') + '.',
    negativePrompt: assets.style?.negativePrompt ?? null,
  }
}
