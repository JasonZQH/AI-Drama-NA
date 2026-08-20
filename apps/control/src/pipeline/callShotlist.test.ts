import { createServer, type Server } from 'node:http'
import { shotlistJsonSchema } from '@ai-drama/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShotlistRejected, callShotlist, type ShotlistInput } from './callShotlist.js'

/**
 * 打桩用 **loopback server，不用 `vi.stubGlobal('fetch')`**。
 *
 * 后者会绕过 `vitest.setup.ts` 里那道出网拦截（它挂在
 * `net.Socket.prototype.connect` 上），等于在这个文件里悄悄把防线关掉——
 * 而 test 车道是 CI 里唯一没有出网限制的。127.0.0.1 是拦截白名单内的。
 */

const input: ShotlistInput = {
  scriptMd: 'INT. APARTMENT - NIGHT\nLena finds the letter.',
  synopsis: 'She comes home to a city that moved on.',
  targetDurationSec: 72,
  scenes: [
    { summary: 'Lena returns', timeOfDay: 'night' },
    { summary: 'The letter', timeOfDay: 'night' },
    { summary: 'The rooftop', timeOfDay: 'night' },
  ],
  characters: [
    { name: 'Lena', description: 'mid-30s, dark bob, grey coat' },
    { name: 'Marcus', description: '40s, close-cropped hair' },
  ],
}

/** 18 镜 × 4s = 72s，三场，景别轮换——刚好全绿 */
const goodDraft = {
  scenes: [0, 1, 2].map((sc) => ({
    shots: Array.from({ length: 6 }, (_, i) => ({
      shotType: (['ms', 'cu', 'ws'] as const)[(sc * 6 + i) % 3]!,
      cameraMove: 'static' as const,
      action: 'Lena crosses the room',
      emotion: '',
      dialogue: '',
      durationSec: 4,
      characterNames: ['Lena'],
    })),
  })),
}

/** 每次请求依次吐出 queue 里的下一条；同时把收到的 body 存起来供断言 */
let queue: string[] = []
let bodies: Record<string, unknown>[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => {
      bodies.push(JSON.parse(buf) as Record<string, unknown>)
      const content = queue.shift() ?? '{}'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0034 } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('拿不到端口')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const run = (...replies: string[]) => {
  queue = replies
  bodies = []
  return callShotlist(input, { apiKey: 'test', baseUrl })
}

describe('callShotlist', () => {
  it('正常输出：过 L1+L2，一轮就成', async () => {
    const r = await run(JSON.stringify(goodDraft))
    expect(r.draft.scenes).toHaveLength(3)
    expect(r.repaired).toBe(false)
    expect(r.warnings).toEqual([])
    expect(r.costUsd).toBeCloseTo(0.0034)
    expect(bodies).toHaveLength(1) // 没有多花一次钱
  })

  it('markdown 包裹的 JSON 也吃得下', async () => {
    const r = await run('```json\n' + JSON.stringify(goodDraft) + '\n```')
    expect(r.draft.scenes).toHaveLength(3)
    expect(r.repaired).toBe(false)
  })

  /** L1 的价值就在这条：schema 是转向器，闸门是 safeParse */
  it('编造的角色名在 L1 被 zod 拒掉，并触发那一轮修复', async () => {
    const bogus = structuredClone(goodDraft) as typeof goodDraft
    bogus.scenes[0]!.shots[0]!.characterNames = ['Batman']
    const r = await run(JSON.stringify(bogus), JSON.stringify(goodDraft))
    expect(r.repaired).toBe(true)
    expect(bodies).toHaveLength(2)
    // 修复那一轮要把错误原文喂回去，否则模型只能瞎猜
    const msgs = bodies[1]!['messages'] as { role: string; content: string }[]
    expect(msgs.at(-1)!.role).toBe('user')
    expect(msgs.at(-1)!.content).toMatch(/Batman|characterNames|scenes\.0\.shots\.0/)
  })

  it('L2 的集级错误同样触发修复，且错误原文进了对话', async () => {
    // 12 镜 × 4s = 48s vs 目标 72s → E3
    const short = { scenes: goodDraft.scenes.map((s) => ({ shots: s.shots.slice(0, 4) })) }
    const r = await run(JSON.stringify(short), JSON.stringify(goodDraft))
    expect(r.repaired).toBe(true)
    const msgs = bodies[1]!['messages'] as { role: string; content: string }[]
    expect(msgs.at(-1)!.content).toMatch(/总时长 48\.0 秒/)
  })

  it('两轮都不过就抛 ShotlistRejected，不会一直烧钱', async () => {
    const bogus = structuredClone(goodDraft) as typeof goodDraft
    bogus.scenes[0]!.shots[0]!.characterNames = ['Batman']
    await expect(run(JSON.stringify(bogus), JSON.stringify(bogus))).rejects.toBeInstanceOf(ShotlistRejected)
    expect(bodies).toHaveLength(2) // 就两次，不是三次
  })

  it('不是合法 JSON 也走同一条修复路径', async () => {
    const r = await run('抱歉，我需要更多信息。', JSON.stringify(goodDraft))
    expect(r.repaired).toBe(true)
    const msgs = bodies[1]!['messages'] as { role: string; content: string }[]
    expect(msgs.at(-1)!.content).toMatch(/不是合法 JSON/)
  })

  /**
   * 缺 `require_parameters` = OpenRouter 可以路由到不声明 structured_outputs
   * 的端点，`response_format` 静默降级成 json_object。症状是「偶尔莫名其妙
   * 解析失败」，在日志里看不出原因——所以这三行得被钉死。
   */
  it('三行必配项都在请求体里', async () => {
    await run(JSON.stringify(goodDraft))
    const b = bodies[0]!
    expect(b['response_format']).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'shotlist', strict: true },
    })
    expect(b['provider']).toEqual({ require_parameters: true })
    expect(b['plugins']).toEqual([{ id: 'response-healing' }])
    // healing 只对非流式生效
    expect(b['stream']).toBeUndefined()
  })

  it('角色名灌进了发出去的 schema——L0 转向的那一半', async () => {
    await run(JSON.stringify(goodDraft))
    const schema = JSON.stringify(bodies[0]!['response_format'])
    expect(schema).toContain('"Lena"')
    expect(schema).toContain('"Marcus"')
  })
})

describe('shotlistJsonSchema（发出去的那份）', () => {
  const wire = shotlistJsonSchema(['Lena'])
  const flat = JSON.stringify(wire)

  /**
   * `z.toJSONSchema()` 会忠实地渲染出 minLength/minimum/maximum/minItems。
   * OpenAI 系的 strict 子集**不接受**这些关键字（整个 schema 被拒），
   * Gemini 的 OpenAPI 子集对它们处理不稳。留着没有收益：闸门是 safeParse。
   */
  it('数值与长度 bounds 一个都不发出去', () => {
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', '$schema']) {
      expect(flat, `${k} 不该出现在发给模型的 schema 里`).not.toContain(k)
    }
  })

  it('strict 要的三样一个都不能少', () => {
    const shot = (
      (wire['properties'] as Record<string, Record<string, Record<string, unknown>>>)['scenes']![
        'items'
      ] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    )['properties']!['shots']!['items'] as Record<string, unknown>
    expect(shot['additionalProperties']).toBe(false)
    expect(shot['required']).toEqual([
      'shotType',
      'cameraMove',
      'action',
      'emotion',
      'dialogue',
      'durationSec',
      'characterNames',
    ])
    // properties 的键是字段名，不能被白名单筛掉
    expect(Object.keys(shot['properties'] as object)).toHaveLength(7)
  })

  it('角色名 enum 与 shotType enum 都还在', () => {
    expect(flat).toContain('"Lena"')
    expect(flat).toContain('"establishing"')
  })
})
