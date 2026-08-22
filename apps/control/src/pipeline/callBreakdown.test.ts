import { createServer, type Server } from 'node:http'
import { breakdownJsonSchema, toTimeOfDay } from '@ai-drama/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BreakdownRejected,
  breakdownSystemPrompt,
  breakdownUserPrompt,
  callBreakdown,
  type BreakdownInput,
} from './callBreakdown.js'

/**
 * 打桩用 loopback server，不用 `vi.stubGlobal('fetch')`——后者会绕过
 * `vitest.setup.ts` 的出网拦截，等于在这个文件里悄悄关掉那道防线。
 * 与 `callShotlist.test.ts` 同一个 seam。
 */
const input: BreakdownInput = {
  scriptMd:
    '## 一\n\n内景 · 玄关 — 夜\n\n她把戒指放进碟子。\n\n## 二\n\n内景 · 楼道 — 黎明\n\n门铃响了一声。',
  synopsis: '她回到一座已经不认识她的城市。',
  minShotSec: 4,
  knownLocations: ['玄关'],
  knownCharacters: ['林知夏'],
}

const good = {
  scenes: [
    {
      summary: '她在玄关把戒指放进碟子',
      locationName: '玄关',
      characterNames: ['林知夏'],
      timeOfDay: 'night',
      lighting: '鞋柜上一盏小夜灯，光只够照亮她的手',
    },
    {
      summary: '楼道里门铃响了一声',
      locationName: '楼道',
      characterNames: ['林知夏', '陈默'],
      timeOfDay: 'dawn',
      lighting: '',
    },
  ],
  targetDurationSec: 48,
  logline: '她以为那扇门后面没有人。',
  hook: '戒指落进碟子的那一声。',
  cliffhanger: '门外的人浑身湿透。',
}

let queue: string[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const content = queue.shift() ?? JSON.stringify(good)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0031 } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/v1`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const run = (...responses: string[]) => {
  queue = responses
  return callBreakdown(input, { apiKey: 'k', baseUrl })
}

describe('callBreakdown', () => {
  it('正常输出过 L1，成本如实带回', async () => {
    const r = await run(JSON.stringify(good))
    expect(r.breakdown.scenes).toHaveLength(2)
    expect(r.breakdown.targetDurationSec).toBe(48)
    expect(r.costUsd).toBeCloseTo(0.0031)
  })

  it('markdown 包裹的 JSON 也要能吃下——strict 不是保证', async () => {
    const r = await run('```json\n' + JSON.stringify(good) + '\n```')
    expect(r.breakdown.scenes).toHaveLength(2)
  })

  /**
   * **不修复。** 分镜那边错误原文回灌重来一轮，因为它有一整套可机器校验的判据；
   * 拆解没有——「这个剧本该分几场」没有对错。所以失败就抛，人重点一次（$0.003）
   * 比白烧一轮修复再交人便宜。
   */
  it('过不了 L1 就抛，不重来一轮', async () => {
    const bad = { scenes: [], targetDurationSec: 48, logline: '', hook: '', cliffhanger: '' }
    await expect(run(JSON.stringify(bad))).rejects.toThrow(BreakdownRejected)
    expect(queue, '只该发一次请求').toHaveLength(0)
  })

  it('不是合法 JSON 时报错要说清是解码坏了', async () => {
    await expect(run('好的，我这就给你拆')).rejects.toThrow(/不是合法 JSON/)
  })
})

describe('提示词', () => {
  const p = breakdownSystemPrompt(input)

  /**
   * **不给场次数上下限。** 那正是要让模型按剧本决定的东西——给了范围它就会去
   * 凑数，而凑出来的划分比人拍脑袋更糟（人至少读过剧本）。
   */
  it('不给场次数范围，但给时长的物理下限', () => {
    expect(p, '10 镜 × 4 秒 = 40 秒，seedance 上做不出更短的').toContain('under 40 seconds')
    expect(p).not.toMatch(/\b\d+ to \d+ scenes\b/)
  })

  it('要求复用已有地点，只在剧本需要新地方时才发明', () => {
    expect(p).toMatch(/Reuse a name from KNOWN LOCATIONS/)
    expect(p, '门外走廊那一类：镜头去过的地方就是一个地点').toMatch(/still the corridor/)
  })

  it('user prompt 把已有资产发出去——不然模型每一场都发明一个新名字', () => {
    const u = breakdownUserPrompt(input)
    expect(u).toContain('<known-locations>\n玄关')
    expect(u).toContain('<known-characters>\n林知夏')
    expect(u.indexOf('<script>')).toBeLessThan(u.indexOf('Break the script above'))
  })
})

describe('toTimeOfDay：自由文本收敛成枚举', () => {
  it('认得出的收敛，认不出的一律 null', () => {
    expect(toTimeOfDay('night')).toBe('night')
    expect(toTimeOfDay('  Dawn ')).toBe('dawn')
    // 猜一个错的时段比留空更贵——留空还有 lighting 兜着
    expect(toTimeOfDay('凌晨三点')).toBeNull()
    expect(toTimeOfDay('')).toBeNull()
  })
})

describe('breakdownJsonSchema（发出去的那份）', () => {
  const wire = breakdownJsonSchema()
  const scene = (
    (wire['properties'] as Record<string, Record<string, unknown>>)['scenes']!['items'] as Record<
      string,
      unknown
    >
  )['properties'] as Record<string, unknown>

  it('strict 要的两样：全必填 + 封死', () => {
    const items = (wire['properties'] as Record<string, Record<string, unknown>>)['scenes']![
      'items'
    ] as Record<string, unknown>
    expect(items['additionalProperties']).toBe(false)
    expect(items['required']).toEqual(Object.keys(scene))
  })

  /**
   * 地点与角色**故意是自由文本，不是 enum**——与分镜那边正好相反。分镜阶段编一个
   * 不存在的角色就是错的；而这一步的全部意义就是把剧本里客观存在、资产库里还
   * 没有的东西找出来。灌成 enum 的话它永远报不出「你缺门外走廊」。
   */
  it('地点与角色不给 enum——那会让它永远报不出缺什么', () => {
    expect(scene['locationName']).not.toHaveProperty('enum')
    expect((scene['characterNames'] as Record<string, Record<string, unknown>>)['items']).not.toHaveProperty(
      'enum',
    )
  })

  it('数值 bounds 被白名单剃掉了——各家方言分叉最厉害的一处', () => {
    expect(JSON.stringify(wire)).not.toMatch(/"(minimum|maximum|minLength|minItems)"/)
  })
})
