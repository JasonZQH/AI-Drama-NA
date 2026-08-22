import { describe, expect, it } from 'vitest'
import { buildPrompt, type PromptAssets, type PromptIntent } from './prompt.js'

const LENA = {
  name: 'Lena',
  description: 'woman, 25, shoulder-length black hair, beige trench coat',
  anchorTokens: ['beige trench coat', 'silver crescent pendant'],
}

const intent = (over: Partial<PromptIntent> = {}): PromptIntent => ({
  shotType: 'cu',
  action: 'Lena scans the room, jaw tight',
  cameraMove: null,
  emotion: null,
  timeOfDay: null,
  lighting: null,
  hiddenTraits: [],
  ...over,
})

const assets = (over: Partial<PromptAssets> = {}): PromptAssets => ({
  characters: [],
  location: null,
  style: null,
  ...over,
})

describe('buildPrompt', () => {
  it('景别缩写展开成人话——「cu」对模型不是词', () => {
    expect(buildPrompt(intent({ shotType: 'cu' }), assets()).prompt).toMatch(/^close-up, /)
    expect(buildPrompt(intent({ shotType: 'ecu' }), assets()).prompt).toMatch(/^extreme close-up, /)
    expect(buildPrompt(intent({ shotType: 'ots' }), assets()).prompt).toMatch(/^over-the-shoulder shot, /)
    expect(buildPrompt(intent({ shotType: 'establishing' }), assets()).prompt).toMatch(/^establishing shot, /)
  })

  /**
   * 这条是本 PR 的存在理由。
   *
   * 跨镜头角色一致性靠的是「同一个角色每一镜都带着同一串视觉锚点进 prompt」
   * （ADR-0008）。此前 prompt 是 `${action}, ${shotType}` 拼串，连角色名都没有，
   * seed 好的锚点零使用。
   */
  it('角色的描述与锚点都进 prompt——一致性靠它', () => {
    const p = buildPrompt(intent(), assets({ characters: [LENA] })).prompt
    expect(p).toContain('Lena, woman, 25')
    expect(p).toContain('shoulder-length black hair')
    expect(p).toContain('silver crescent pendant')
  })

  it('锚点与描述重叠的部分去重，且保序', () => {
    const p = buildPrompt(intent(), assets({ characters: [LENA] })).prompt
    // 'beige trench coat' 在 description 和 anchorTokens 里各有一次
    expect(p.match(/beige trench coat/g)).toHaveLength(1)
    expect(p.indexOf('beige trench coat')).toBeLessThan(p.indexOf('silver crescent pendant'))
  })

  it('空镜合法：没有角色不该拼出空从句', () => {
    const p = buildPrompt(intent({ shotType: 'establishing' }), assets()).prompt
    expect(p).toBe('establishing shot, Lena scans the room, jaw tight.')
    expect(p).not.toMatch(/\.\s*\./)
    expect(p, '没有角色时不该留下空的逗号位').not.toMatch(/, ,|^, |, \.$/)
  })

  it('多角色各自一句，不混成一串', () => {
    const p = buildPrompt(
      intent(),
      assets({ characters: [LENA, { name: 'Marcus', description: 'man, 32', anchorTokens: ['scar'] }] }),
    ).prompt
    expect(p).toContain('Lena, woman, 25')
    expect(p).toContain('Marcus, man, 32, scar')
  })

  it('地点区分室内外，时间转成人话', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'night' }),
      assets({
        location: { description: 'city rooftop', interior: false, anchorTokens: ['distant skyline'] },
      }),
    ).prompt
    expect(p).toContain('outdoors, city rooftop, distant skyline')
    expect(p).toContain('night')
    expect(
      buildPrompt(
        intent(),
        assets({ location: { description: 'small urban cafe', interior: true, anchorTokens: [] } }),
      ).prompt,
    ).toContain('indoors, small urban cafe')
  })

  it('运镜与情绪有值才出现', () => {
    expect(buildPrompt(intent(), assets()).prompt).not.toContain('camera')
    const p = buildPrompt(intent({ cameraMove: 'dolly', emotion: 'tense' }), assets()).prompt
    expect(p).toContain('slow dolly in')
    expect(p).toContain('tense')
  })

  it('风格进正向，负向词单独返回不混进 prompt', () => {
    const r = buildPrompt(
      intent(),
      assets({ style: { description: 'cinematic, high contrast', negativePrompt: 'cartoon, watermark' } }),
    )
    expect(r.prompt).toContain('cinematic, high contrast')
    expect(r.prompt).not.toContain('cartoon')
    expect(r.negativePrompt).toBe('cartoon, watermark')
  })

  it('没有 style 时负向词是 null，不是空串', () => {
    expect(buildPrompt(intent(), assets()).negativePrompt).toBeNull()
  })

  /**
   * 三处标签前缀全部去掉。
   *
   * `Interior:` / `Exterior:` 是**剧本 slugline** 的约定，`Style:` 同理——两家
   * 官方例句里没有任何标签前缀，模型吃的是白描散文。而 `Lena:` 尤其危险：
   * **冒号后接内容正是 Veo 的台词语法**，拿它分隔角色描述有把整串特征当台词
   * 烧进画面的风险，而 style 的负向词里「text overlay」正是在防这个。
   */
  it('不带任何剧本式标签前缀', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'night', cameraMove: 'orbit' }),
      assets({
        characters: [LENA],
        location: { description: 'city rooftop', interior: false, anchorTokens: [] },
        style: { description: 'cinematic', negativePrompt: null },
      }),
    ).prompt
    for (const tag of ['Style:', 'Interior:', 'Exterior:', 'Lena:']) {
      expect(p, `${tag} 是剧本/台词语法，不该进 prompt`).not.toContain(tag)
    }
    // 冒号一个都不该有
    expect(p).not.toContain(':')
  })

  /** 「往哪推」不加列，靠默认值——但默认值本身得钉住 */
  it('dolly 与 orbit 带方向，不让模型自己猜', () => {
    expect(buildPrompt(intent({ cameraMove: 'dolly' }), assets()).prompt).toContain('slow dolly in')
    expect(buildPrompt(intent({ cameraMove: 'orbit' }), assets()).prompt).toContain('arc shot')
  })

  /**
   * seed 的 Rooftop 写的就是 `city rooftop at night`。不查的话拼出
   * 「…at night. night.」——同一个词两遍，读起来像系统坏了。
   */
  it('location 文本已含时间词就不再补一次', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'night' }),
      assets({ location: { description: 'city rooftop at night', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(p.match(/night/g), 'night 出现了不止一次').toHaveLength(1)
    // 不含时间词时仍要补上
    const q = buildPrompt(
      intent({ timeOfDay: 'night' }),
      assets({ location: { description: 'city rooftop', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(q).toMatch(/city rooftop, night/)
  })

  /**
   * 光照是短剧里区分度最高的一项，而枚举只有四格。
   *
   * 「路灯刚亮，招牌还没全开」和 `night` 在画面上完全是两回事——自由文本必须
   * 压过枚举，否则加这一列没有意义。
   */
  it('lighting 自由文本压过 timeOfDay 的固定词', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'night', lighting: 'streetlamps just flickered on, signage still dark' }),
      assets({ location: { description: 'city alley', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(p).toContain('streetlamps just flickered on')
    expect(p, '枚举那个词不该同时出现').not.toMatch(/city alley, night\./)
  })

  it('没有 lighting 时回落到枚举', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'dusk', lighting: null }),
      assets({ location: { description: 'city alley', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(p).toContain('city alley, dusk light')
  })

  it('lighting 是空白串时也回落，不拼出一个空从句', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'night', lighting: '   ' }),
      assets({ location: { description: 'city alley', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(p).toContain('city alley, night')
    expect(p).not.toMatch(/,\s*,|,\s*\./)
  })

  /**
   * 去重那一行做的是 `new RegExp(`\\b${timeProse}\\b`)`。枚举时代 `timeProse`
   * 是四个常量之一，怎么拼都安全；自由文本一进来它就是**用户输入进正则构造器**：
   *
   * - `lamp (cold` → `SyntaxError`，`prompt-preview` 与入队路径一起 500
   * - `dawn. hard shadows` → `.` 当通配，静默匹上地点描述，**整句光照被吞掉**
   *
   * 后者更贵：不报错、不留痕，只是那一镜的光没了。
   */
  it('光照里的正则元字符既不该炸也不该被静默吃掉', () => {
    const p = buildPrompt(
      intent({ timeOfDay: null, lighting: 'a single lamp (cold' }),
      assets({ location: { description: 'city alley', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(p).toContain('a single lamp (cold')

    // `.` 当通配符时会匹上 `dawnx hard shadows`，于是这一句光照整个不见
    const q = buildPrompt(
      intent({ timeOfDay: null, lighting: 'dawn. hard shadows' }),
      assets({
        location: { description: 'rooftop at dawnx hard shadows', interior: false, anchorTokens: [] },
      }),
    ).prompt
    expect(q, '`.` 不该当通配符把整句光照吃掉').toContain('dawn. hard shadows')

    // 转义而不是「自由文本一律不查」：去重本身要留着
    const r = buildPrompt(
      intent({ timeOfDay: null, lighting: 'night' }),
      assets({ location: { description: 'city rooftop at night', interior: false, anchorTokens: [] } }),
    ).prompt
    expect(r.match(/night/g), '光照与地点写了同一个词，不该拼两遍').toHaveLength(1)
  })

  /**
   * **锚点被剧情拿走之后就不该再拼进来。**
   *
   * 真机实测：角色锚点里配了 `brass key on a cord at her neck`，剧本第 2 镜她把
   * 钥匙摘下放到桌上。拼出来的 prompt 在同一句里既有那串锚点、又有「她把钥匙
   * 放到桌上」；摘下之后的第 3、5、6、8、9、11 镜照旧带着它。成片上肉眼可见：
   * 第 2 镜末帧钥匙在桌上，第 3 镜又回到脖子上。
   */
  it('hiddenTraits 里的锚点被摘掉，其余的留着', () => {
    const cast = {
      characters: [
        {
          name: 'MAYA',
          description: 'woman in her twenties, tired eyes',
          anchorTokens: ['faded blue scrubs', 'brass key on a cord at her neck'],
        },
      ],
    }
    const before = buildPrompt(intent(), assets(cast)).prompt
    expect(before, '没摘之前该在').toContain('brass key on a cord at her neck')

    const after = buildPrompt(
      intent({ hiddenTraits: ['brass key on a cord at her neck'] }),
      assets(cast),
    ).prompt
    expect(after, '摘了就不该再拼进来').not.toContain('brass key')
    expect(after, '别的锚点是身份，不能跟着一起没了').toContain('faded blue scrubs')
    expect(after, '角色本人还在').toContain('MAYA')
    expect(after, '不该拼出空洞或双逗号').not.toMatch(/,\s*,|,\s*\./)
  })

  /**
   * 写在 `description` 结尾的那一项也要摘得掉。
   *
   * `traits()` 会把 `description` 也按逗号拆开，所以只过滤 `anchorTokens` 会漏——
   * 这正是过滤点放在 `characterClause` 而不是 `resolvePrompt` 的理由。
   */
  it('description 里的那一项同样摘得掉', () => {
    const p = buildPrompt(
      intent({ hiddenTraits: ['gold wedding band'] }),
      assets({
        characters: [
          { name: 'MAYA', description: 'woman in her twenties, gold wedding band', anchorTokens: [] },
        ],
      }),
    ).prompt
    expect(p).not.toContain('gold wedding band')
    expect(p).toContain('woman in her twenties')
  })

  /**
   * **精确匹配，不做子串。** 子串会把 `scar` 当成 `scarf` 吃掉——与 `dedupe`
   * 收窄成全等是同一个理由，而锚点里出现这种短词是常态。
   */
  it('精确匹配：摘 scar 不该把 scarf 一起摘了', () => {
    const p = buildPrompt(
      intent({ hiddenTraits: ['scar'] }),
      assets({
        characters: [{ name: 'MAYA', description: 'tired eyes', anchorTokens: ['scarf', 'scar'] }],
      }),
    ).prompt
    expect(p, 'scarf 是另一样东西').toContain('scarf')
    expect(p.match(/\bscar\b/), '独立的 scar 该没了').toBeNull()
  })

  it('大小写与首尾空格不影响匹配——模型的输出不保证规整', () => {
    const p = buildPrompt(
      intent({ hiddenTraits: ['  Brass Key  '] }),
      assets({
        characters: [{ name: 'MAYA', description: 'tired eyes', anchorTokens: ['brass key'] }],
      }),
    ).prompt
    expect(p).not.toContain('brass key')
  })

  /**
   * dialogue 不进 prompt：它驱动 TTS（schema 注释就是这么写的），而把带引号的
   * 台词塞进视频 prompt 会诱导模型把字 render 进画面——style_profiles 的负向词
   * 里「text overlay」正是在防这个。`PromptIntent` 里因此根本没有这个字段，
   * 这条用例守的是「别哪天顺手加回来」。
   */
  it('PromptIntent 不含 dialogue', () => {
    expect(Object.keys(intent())).not.toContain('dialogue')
  })
})
