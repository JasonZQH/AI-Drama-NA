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
   * dialogue 不进 prompt：它驱动 TTS（schema 注释就是这么写的），而把带引号的
   * 台词塞进视频 prompt 会诱导模型把字 render 进画面——style_profiles 的负向词
   * 里「text overlay」正是在防这个。`PromptIntent` 里因此根本没有这个字段，
   * 这条用例守的是「别哪天顺手加回来」。
   */
  it('PromptIntent 不含 dialogue', () => {
    expect(Object.keys(intent())).not.toContain('dialogue')
  })
})
