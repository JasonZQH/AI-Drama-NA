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
export const SHOT_TYPE_PROSE: Record<ShotType, string> = {
  establishing: 'establishing shot',
  ws: 'wide shot',
  ms: 'medium shot',
  cu: 'close-up',
  ecu: 'extreme close-up',
  ots: 'over-the-shoulder shot',
  pov: 'point-of-view shot',
}

/**
 * **给方向，不加列。**
 *
 * `dolly` 和 `orbit` 不说方向，模型只能自己猜——同一批镜头里一半推近一半拉远。
 * 但「往哪推」不值得为它加一个数据库列：短剧里推近是绝对多数（情绪递进），
 * 真需要拉远的那几镜可以写进 `action`。默认值选多数派，代价是少数派要绕。
 */
export const CAMERA_MOVE_PROSE: Record<CameraMove, string> = {
  static: 'static camera',
  pan: 'camera pans',
  tilt: 'camera tilts',
  dolly: 'slow dolly in',
  orbit: 'arc shot',
  handheld: 'handheld camera',
}

export const TIME_OF_DAY_PROSE: Record<TimeOfDay, string> = {
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
  /**
   * 场景级自由文本光照（`scenes.lighting`）。**有它就用它，压过 `timeOfDay`。**
   *
   * 枚举只有四格、映射成四个固定英文词，而光照恰恰是短剧里区分度最高的一项
   * （「路灯刚亮」和「深夜」在画面上完全是两回事）。枚举留作粗分桶与统计。
   */
  readonly lighting: string | null
  /**
   * 到这一镜为止已经不在角色身上的锚点（`shots.hidden_anchors` 的投影）。
   *
   * 见 `characterClause`。空数组 = 没有任何东西被拿走。
   */
  readonly hiddenTraits: readonly string[]
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

/**
 * 锚点是「跨镜头一致性」的载体（ADR-0008）：同一个角色在每一镜都带着同一串
 * 视觉锚点进 prompt，模型才有机会画成同一个人。
 *
 * **同位语，不是冒号。** 冒号后接内容正是 Veo 的台词语法（`Lena: "You did."`
 * 会被当成要说的话），拿它分隔角色描述，有把整串特征当台词烧进画面的风险。
 * 两家官方例句里角色都是同位语形式。
 */
function characterClause(c: PromptCharacter, hidden: ReadonlySet<string>): string {
  /*
   * **剧情把东西拿走之后，锚点就从一致性手段变成了自相矛盾。**
   *
   * 真机实测：角色锚点里配了 `brass key on a cord at her neck`，剧本第 2 镜她把
   * 钥匙摘下放到桌上。拼出来的 prompt 在同一句里既有那串锚点、又有「她把钥匙
   * 放到桌上」；而摘下之后的第 3、5、6、8、9、11 镜照旧带着它。成片上肉眼可见：
   * 第 2 镜末帧钥匙在桌上，第 3 镜又回到脖子上。
   *
   * **逐镜状态赢。** 锚点是默认值，`hiddenTraits` 是这一镜的事实。
   *
   * 过滤放在这里而不是 `resolvePrompt`：`traits()` 会把 `description` 也按逗号
   * 拆开，只过滤 `anchorTokens` 会漏掉写在描述结尾的那一项。
   *
   * **精确匹配不做子串**：子串会把 `scar` 当成 `scarf` 吃掉——与 `dedupe` 收窄
   * 成全等是同一个理由，而锚点里出现这种短词是常态。
   */
  const t = traits([c.description, ...c.anchorTokens]).filter((x) => !hidden.has(x.toLowerCase()))
  return `${c.name}, ${t.join(', ')}`
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

  /*
   * **景别 + 角色 + 动作合成一句，逗号相接。**
   *
   * 两家官方模板都是这个形状（`{景别} of {主体}, {动作}`）——主体与描述它的
   * 镜头语言在同一个从句里，模型才知道「这个中景是在拍谁」。拆成三句之后
   * 「medium shot.」自己成一句，没有主语。
   *
   * 其余（地点、时间、风格）保持句号分隔：它们是环境，不是主体。
   */
  const hidden = new Set(intent.hiddenTraits.map((h) => h.trim().toLowerCase()))
  const subject = [framing, ...assets.characters.map((c) => characterClause(c, hidden)), action]
    .filter((x) => x.length > 0)
    .join(', ')

  // 自由文本优先：四个枚举词是兜底，不是上限
  const timeProse = intent.lighting?.trim() || (intent.timeOfDay ? TIME_OF_DAY_PROSE[intent.timeOfDay] : null)

  /*
   * 地点：**白描散文，不带标签前缀。**
   *
   * `Interior:` / `Exterior:` 是剧本 slugline 的约定，不是给模型的语言——两家
   * 官方例句里没有任何标签前缀。改成介词从句。
   *
   * 时间词折进同一句：裸一句 `night.` 是个没有主语的片段。而 location 文本
   * 本来就含该词时跳过——seed 的 Rooftop 写的就是 `city rooftop at night`，
   * 不查的话会拼出「…at night. night.」。
   */
  const locationSentence = ((): string | null => {
    if (!assets.location) return timeProse
    const body = traits([assets.location.description, ...assets.location.anchorTokens]).join(', ')
    const where = `${assets.location.interior ? 'indoors' : 'outdoors'}, ${body}`
    if (!timeProse) return where
    /*
     * 已经写了 night / dusk 之类就不再补一次。
     *
     * **`timeProse` 必须转义**：枚举时代它是四个常量之一，怎么拼都安全；自由
     * 文本一进来，这一行就是把用户输入喂进正则构造器——`lamp (cold` 直接
     * SyntaxError（预览与入队路径一起 500），`dawn. hard shadows` 里的 `.` 当
     * 通配符匹上地点描述、**整句光照被吞掉且不报错不留痕**。后者更贵。
     *
     * 转义而不是「自由文本一律不查重」：去重本身是要留的——地点写着
     * `city rooftop at night`、光照也写 `night` 时，拼出「…at night, night.」
     * 同样是坏输出。Node 22 没有 `RegExp.escape`，所以手写。
     */
    const literal = timeProse.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    return new RegExp(`\\b${literal}\\b`, 'i').test(body) ? where : `${where}, ${timeProse}`
  })()

  const sentences = [
    subject,
    ...(locationSentence ? [locationSentence] : []),
    // `Style:` 同理去标签。风格描述本身就是形容词短语，直接当一句
    ...(assets.style ? [assets.style.description] : []),
  ]

  return {
    prompt: sentences.filter((x) => x.length > 0).join('. ') + '.',
    negativePrompt: assets.style?.negativePrompt ?? null,
  }
}
