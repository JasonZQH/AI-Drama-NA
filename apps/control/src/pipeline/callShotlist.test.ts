import { createServer, type Server } from 'node:http'
import { shotlistDraft, shotlistJsonSchema } from '@ai-drama/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ShotlistRejected,
  callShotlist,
  systemPrompt,
  userPrompt,
  type ShotlistInput,
} from './callShotlist.js'
import { MAX_CAST_PER_SHOT, SAME_SHOT_TYPE_RUN, SHOT_COUNT } from './shotlist.js'

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
  episodeBrief: 'She has ten minutes to decide.\nHook: the letter is addressed to someone else.',
  targetDurationSec: 72,
  minShotSec: 2,
  scenes: [
    // 第一场给自由文本光照，后两场只有枚举——两条回落分支都要被 userPrompt 覆盖到
    { summary: 'Lena returns', timeOfDay: 'night', lighting: 'one bare bulb over the door' },
    { summary: 'The letter', timeOfDay: 'night', lighting: null },
    { summary: 'The rooftop', timeOfDay: 'night', lighting: null },
  ],
  characters: [
    { name: 'Lena', description: 'mid-30s, dark bob', anchorTokens: ['grey wool coat'] },
    { name: 'Marcus', description: '40s, close-cropped hair', anchorTokens: [] },
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

  /**
   * 用 E1（场次数对不上）而不是时长：**时长已经是 W3 了**，偏差只标黄不重试
   * ——一集多长由剧本决定。E1 仍是硬错：场次对不上说明模型没按输入结构走，
   * 后面全会错位。
   */
  it('L2 的集级错误同样触发修复，且错误原文进了对话', async () => {
    // 输入 3 场，只返回 2 场 → E1
    const missing = { scenes: goodDraft.scenes.slice(0, 2) }
    const r = await run(JSON.stringify(missing), JSON.stringify(goodDraft))
    expect(r.repaired).toBe(true)
    const msgs = bodies[1]!['messages'] as { role: string; content: string }[]
    expect(msgs.at(-1)!.content).toMatch(/输入有 3 场，你返回了 2 场/)
  })

  /** 时长偏差**不该**触发那一轮修复——那正是「模型在解算术题」的来源 */
  it('总时长偏离目标不触发修复，只回 warning', async () => {
    const short = { scenes: goodDraft.scenes.map((s) => ({ shots: s.shots.slice(0, 4) })) }
    const r = await run(JSON.stringify(short), JSON.stringify(goodDraft))
    expect(r.repaired, '偏长偏短都不该白烧一轮修复').toBe(false)
    expect(bodies, '只该发一次请求').toHaveLength(1)
    expect(r.warnings.join()).toMatch(/总时长 48\.0 秒/)
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

/**
 * 提示词里的硬规则数字必须与 `lintShotlist` 的判据**同源**。
 *
 * 这组断言守的不是「数字是多少」（那会是重言式——两边同一个来源），守的是
 * **「有人把它改回硬编码」**。
 *
 * ## 覆盖边界（实测过，写出来免得下一个人以为它守得更多）
 *
 * 用**相同的值**退回字面量（把插值换成 `'10 to 25'`），这组断言**不会红**——
 * 输出一模一样，从输出看不出来源。但那是良性的：它在常量分叉的那一刻才变成
 * bug，而那时把 `SHOT_COUNT.max` 改成 30 会让这里立刻红（实测每条常量改动都
 * 红 2 个用例）。
 *
 * 换句话说：**同值硬编码是潜伏的，而它从潜伏变成有害的那一刻正好被抓住。**
 * 要更强的保证只能靠 lint 规则（禁止这个文件出现裸数字），那不值当。
 *
 * 为什么值得守：两份不同步的后果是不对称的。判据改大而提示词没改 = 改了等于
 * 没改（模型仍按旧上限产）；提示词改大而判据没改 = 模型照新的产、lint 判死，
 * **每次生成白烧一轮修复再失败**，而日志里看不出是这个原因。
 */
describe('systemPrompt 的硬规则与判据同源', () => {
  const p = systemPrompt({
    scriptMd: 'x',
    synopsis: null,
    episodeBrief: null,
    targetDurationSec: 72,
    minShotSec: 2,
    scenes: [
      { summary: null, timeOfDay: null, lighting: null },
      { summary: null, timeOfDay: null, lighting: null },
    ],
    characters: [],
  })

  it('镜头数区间取自 SHOT_COUNT', () => {
    expect(p).toContain(`${SHOT_COUNT.min} to ${SHOT_COUNT.max} shots total`)
  })

  /**
   * **目标时长现在是一句 roughly，不再是配额。**
   *
   * 原来发的是「must sum to about N (within 15%)」，配一条 error 级判据。真机
   * 实测的后果：目标 30 秒的一集，模型交出 `3.0×8 + 2.0×3 = 30.0`——精确到
   * 小数点后一位，它在解算术题不是在导戏。
   */
  it('目标时长是预期不是配额，容差不再发给模型', () => {
    expect(p).toContain(`land roughly around ${input.targetDurationSec} seconds`)
    expect(p, '「不许为凑数字加戏减戏」要明说').toMatch(/do not pad or compress to hit a number/)
    expect(p, '容差是 lint 侧的事，发给模型只会让它去解算术').not.toMatch(/within 15%|within 0\.15/)
  })

  it('同框人数取自 MAX_CAST_PER_SHOT', () => {
    expect(p).toContain(`At most ${MAX_CAST_PER_SHOT} characters per shot`)
  })

  it('连续同景别取自 SAME_SHOT_TYPE_RUN', () => {
    expect(p).toContain(`the same one ${SAME_SHOT_TYPE_RUN} shots in a row`)
  })

  it('场次数用的是输入的实际场数', () => {
    expect(p).toContain('Return exactly 2 scene objects')
  })

  /**
   * 单镜 2–8 秒是 03 §S3 的**建议**，与 schema 的硬上限（1–10，对齐
   * `shots_duration_ck`）刻意不同：一个是「该怎么写」，一个是「不许越过」。
   * 这条钉住这个区别，免得下一个人"顺手统一"成 1-10。
   */
  /**
   * **下限从 provider 的档位取，上限仍是 03 §S3 的建议值 8 秒。**
   *
   * 写死 `2-8` 的那一版在 seedance 上是错的：它全系最短 4 秒，模型照着写 2 秒，
   * 每一镜都被 `snapDuration` 静默抬档，而整集是按写的那个数算的——真机实测
   * 目标 30 秒的一集出了 44.5 秒的成片。
   *
   * 上限不跟 schema 的 10 秒合并：一个是「该怎么写」，一个是「不许越过」。
   */
  it('单镜时长下限取自 provider 档位，上限仍是建议值 8', () => {
    expect(p, '夹具的 minShotSec 是 2').toContain('from 2 to 8')
    expect(p, '硬上限不该当建议值发出去').not.toContain('1-10 seconds')
    expect(p, '小数会被向上取整到要付钱的那一整秒——说清楚').toMatch(/Whole seconds only/)

    const seedance = systemPrompt({
      scriptMd: 'x',
      synopsis: null,
      episodeBrief: null,
      targetDurationSec: 72,
      minShotSec: 4,
      scenes: [{ summary: null, timeOfDay: null, lighting: null }],
      characters: [],
    })
    expect(seedance, '换成 4 秒起的模型，这句话要跟着变').toContain('from 4 to 8')
    expect(seedance, '要说清楚这是硬地板，不是建议').toMatch(/hard floor/)
  })
})

/**
 * **案例本身必须能过自己的校验。**
 *
 * 示范一个会被 lint 判死的写法是这一整套里最坏的结果：模型照着学，每次生成都白烧
 * 一轮修复再失败，而日志里只会说「校验没过」，不会说「是你教它这么写的」。
 *
 * 所以这一组把案例从 systemPrompt 的输出里**原样解析回来**再验——不是另抄一份
 * 常量对着比（那样两份会漂，而漂了之后测试还是绿的）。
 */
/**
 * userPrompt 的三样新输入，**全部早就落库了，只是从没发出去**。
 * 这一组守的就是「发出去了」这件事——不发的话，加了列也等于没加。
 */
describe('userPrompt 把已落库的上下文发出去', () => {
  const u = userPrompt(input)

  it('episodeBrief 进去了——这是「针对这个剧本的概述」', () => {
    expect(u).toContain('<episode>')
    expect(u).toContain('She has ten minutes to decide.')
    expect(u).toContain('Hook: the letter is addressed to someone else.')
  })

  it('场级 lighting 自由文本优先，没有才回落枚举', () => {
    expect(u, '有自由文本时用它').toContain('Lena returns · one bare bulb over the door')
    expect(u, '没有时回落到枚举那个词').toContain('The letter · night')
  })

  it('锚点发出去，并且说清楚它是自动拼的', () => {
    expect(u).toContain('[always on screen: grey wool coat]')
    expect(u, '不说的话模型会在 action 里把同一件外套再写一遍').toContain(
      'attached to every shot automatically',
    )
    // 没有锚点的角色不该拼出一个空的方括号
    expect(u).not.toContain('[always on screen: ]')
  })

  it('CAST 用破折号不用冒号', () => {
    /*
     * `- Lena: woman, 25…` 与剧本里的台词行 `LIN XIA: 你怎么在这。` 同形。
     * `prompt.ts` 已经为下游同一个理由裁决过一次。
     */
    expect(u).toContain('- Lena — mid-30s, dark bob')
    expect(u).not.toContain('- Lena:')
  })

  it('剧本在指令之前——大块资料先放，要勾掉的清单放末尾', () => {
    expect(u.indexOf('<script>')).toBeLessThan(u.indexOf('<scenes'))
    expect(u.indexOf('<scenes')).toBeLessThan(u.indexOf('Based on the script above'))
  })

  it('场次数出现在 <scenes> 上，E1 判的就是它', () => {
    expect(u).toContain(`<scenes count="${input.scenes.length}">`)
  })
})

describe('systemPrompt 里那条案例', () => {
  const rendered = systemPrompt({
    scriptMd: 'x',
    synopsis: null,
    episodeBrief: null,
    targetDurationSec: 72,
    minShotSec: 2,
    scenes: [{ summary: null, timeOfDay: null, lighting: null }],
    characters: [],
  })
  const raw = /SHOTS FOR THAT SCENE\n(\[[\s\S]*?\])\n<\/example>/.exec(rendered)?.[1]

  it('能从提示词里解析出来（解析不出来说明格式漂了）', () => {
    expect(raw, '案例的形状变了，下面几条就都在验空气').toBeTruthy()
    expect(() => JSON.parse(raw!)).not.toThrow()
  })

  const shots = JSON.parse(raw ?? '[]') as Record<string, unknown>[]

  it('过 L1：占位符当角色名也要合法', () => {
    // 角色名灌 enum，所以要把两个占位符当成这一集的 cast 传进去
    const r = shotlistDraft(['<A>', '<B>']).safeParse({ scenes: [{ shots }] })
    expect(
      r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      '案例过不了自己那道闸门',
    ).toEqual([])
  })

  it('守住集级判据：说话人在 cast 里、同框不超过上限', () => {
    for (const sh of shots) {
      const names = sh['characterNames'] as string[]
      if ((sh['dialogue'] as string).length > 0)
        expect(names.length, `有台词却没人说：${JSON.stringify(sh['action'])}`).toBeGreaterThan(0)
      expect(names.length).toBeLessThanOrEqual(MAX_CAST_PER_SHOT)
    }
  })

  it('不写否定式，不写冒号', () => {
    for (const sh of shots) {
      const text = `${sh['action'] as string} ${sh['emotion'] as string}`
      /*
       * 案例第 4 镜示范的正是「用删除表达消失」：`collar open at her bare throat`
       * 而不是「不再戴着项链」。它要是自己写了否定式，上面那条 Writing style
       * 规则就成了一句自相矛盾的话。
       */
      expect(text, `案例自己写了否定式：${text}`).not.toMatch(
        /\bno\b|\bnot\b|\bwithout\b|\bnever\b|\bdon't\b/i,
      )
      // 冒号后接内容是 Veo 的台词语法，有把描述当台词烧进画面的风险
      expect(text).not.toContain(':')
    }
  })

  it('景别与时长都在变——变化是演示出来的，不靠多写一句文案', () => {
    const types = shots.map((sh) => sh['shotType'])
    expect(new Set(types).size, '四镜同景别就没演示到「Vary shotType」').toBe(shots.length)
    expect(new Set(shots.map((sh) => sh['durationSec'])).size).toBeGreaterThan(2)
  })

  it('里面没有任何专有名词——占位符是唯一的防照抄', () => {
    /*
     * 案例里的人名/地名泄进 `action` **没有任何一层拦得住**（`characterNames`
     * 有 enum 挡着，action 没有）。所以案例里根本不放真名：`<A>` 一眼能被 E7
     * 抓出来，而 `Odile` 这种像真名的东西泄漏了也看不出来。
     */
    for (const sh of shots) {
      /*
       * **只查 `action`。** 泄漏的洞就在这一个字段：`characterNames` 有 enum 挡着，
       * 而 `dialogue` 是一句英文台词，句首本来就大写（"You came."）——把它算进来
       * 只会得到一个每次改台词都要伺候的假阳性。
       */
      const caps = (sh['action'] as string).split(/[\s,.]+/).filter((w) => /^[A-Z][a-z]{2,}$/.test(w))
      expect(caps, `案例里出现了像真名的词：${caps.join('、')}`).toEqual([])
    }
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
