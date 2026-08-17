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
    expect(buildPrompt(intent({ shotType: 'cu' }), assets()).prompt).toMatch(/^close-up\./)
    expect(buildPrompt(intent({ shotType: 'ecu' }), assets()).prompt).toMatch(/^extreme close-up\./)
    expect(buildPrompt(intent({ shotType: 'ots' }), assets()).prompt).toMatch(/^over-the-shoulder shot\./)
    expect(buildPrompt(intent({ shotType: 'establishing' }), assets()).prompt).toMatch(/^establishing shot\./)
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
    expect(p).toContain('Lena:')
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
    expect(p).toBe('establishing shot. Lena scans the room, jaw tight.')
    expect(p).not.toMatch(/\.\s*\./)
  })

  it('多角色各自一句，不混成一串', () => {
    const p = buildPrompt(
      intent(),
      assets({ characters: [LENA, { name: 'Marcus', description: 'man, 32', anchorTokens: ['scar'] }] }),
    ).prompt
    expect(p).toContain('Lena: woman, 25')
    expect(p).toContain('Marcus: man, 32, scar')
  })

  it('地点区分室内外，时间转成人话', () => {
    const p = buildPrompt(
      intent({ timeOfDay: 'night' }),
      assets({
        location: { description: 'city rooftop', interior: false, anchorTokens: ['distant skyline'] },
      }),
    ).prompt
    expect(p).toContain('Exterior: city rooftop, distant skyline')
    expect(p).toContain('night')
    expect(
      buildPrompt(
        intent(),
        assets({ location: { description: 'small urban cafe', interior: true, anchorTokens: [] } }),
      ).prompt,
    ).toContain('Interior: small urban cafe')
  })

  it('运镜与情绪有值才出现', () => {
    expect(buildPrompt(intent(), assets()).prompt).not.toContain('camera')
    const p = buildPrompt(intent({ cameraMove: 'dolly', emotion: 'tense' }), assets()).prompt
    expect(p).toContain('dolly move')
    expect(p).toContain('tense')
  })

  it('风格进正向，负向词单独返回不混进 prompt', () => {
    const r = buildPrompt(
      intent(),
      assets({ style: { description: 'cinematic, high contrast', negativePrompt: 'cartoon, watermark' } }),
    )
    expect(r.prompt).toContain('Style: cinematic, high contrast')
    expect(r.prompt).not.toContain('cartoon')
    expect(r.negativePrompt).toBe('cartoon, watermark')
  })

  it('没有 style 时负向词是 null，不是空串', () => {
    expect(buildPrompt(intent(), assets()).negativePrompt).toBeNull()
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
