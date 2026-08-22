import { createServer, type Server } from 'node:http'
import { scriptJsonSchema } from '@ai-drama/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ScriptRejected,
  callScript,
  scriptSystemPrompt,
  scriptUserPrompt,
  type ScriptInput,
} from './callScript.js'
import { SHOT_COUNT } from './shotlist.js'

/** loopback server，不用 vi.stubGlobal('fetch')——理由见 callShotlist.test.ts */
const input: ScriptInput = {
  source: '深夜末班地铁上只有两个人。一个女孩，和一个抱着保温杯睡着的男人。列车过弯，杯子滚到她脚边。',
  genre: '中式都市情感，克制，不煽情',
  synopsis: null,
  minShotSec: 2,
  knownCharacters: ['林小满'],
}

const good = {
  title: '最后一班',
  scriptMd:
    '## 一 · 站台\n\n内景 · 地铁站台 — 深夜\n\n林小满坐在长椅最边上，手腕上一条褪色红绳。\n\n**林小满**：还有四分钟。\n\n## 二 · 车厢\n\n内景 · 末班车厢 — 深夜\n\n保温杯从他膝盖滑下来，滚到她脚边。\n\n**男人**：到哪了？\n'.padEnd(
      260,
      '。',
    ),
}

let queue: string[] = []
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      const content = queue.shift() ?? JSON.stringify(good)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.004 } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/v1`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const run = (...responses: string[]) => {
  queue = responses
  return callScript(input, { apiKey: 'k', baseUrl })
}

describe('callScript', () => {
  it('正常输出过 L1，成本如实带回', async () => {
    const r = await run(JSON.stringify(good))
    expect(r.draft.title).toBe('最后一班')
    expect(r.draft.scriptMd).toContain('## 一 · 站台')
    expect(r.costUsd).toBeCloseTo(0.004)
  })

  /**
   * 太短的「剧本」过不了闸。200 字以下的东西撑不起 10 镜——它会让分镜层去编，
   * 而编出来的镜头没有质感，那正是「剧本太薄 → 通用镜头」那条链的起点。
   */
  it('太短的稿子被 L1 拒掉，不会一路流到分镜', async () => {
    await expect(run(JSON.stringify({ title: 'x', scriptMd: '很短' }))).rejects.toThrow(ScriptRejected)
    expect(queue, '不修复——重点一次比白烧一轮便宜').toHaveLength(0)
  })

  it('不是合法 JSON 时说清是解码坏了', async () => {
    await expect(run('好的，我这就写')).rejects.toThrow(/不是合法 JSON/)
  })
})

describe('编剧提示词把「拍得出来」前置', () => {
  const p = scriptSystemPrompt(input)

  /**
   * 剧本是给这条流水线用的。写一场十个人的追车戏是**不可执行的输出**——单镜最多
   * 2 个角色，而没有任何一层会在生成之前说。约束前置比事后在分镜层判死便宜。
   */
  it('把单镜人数上限写进编剧口径', () => {
    expect(p).toMatch(/At most 2 characters in any one moment/)
    expect(p, '要说清后果，不然它只是一条没来由的规矩').toMatch(/breaks the video model/)
  })

  it('篇幅按镜数与档位下限倒推，不让它写一集 20 场的电视剧', () => {
    expect(p).toContain(`${SHOT_COUNT.min}–${SHOT_COUNT.max} shots`)
    expect(p, '夹具的 minShotSec 是 2').toContain('at least 2 seconds')
  })

  /** 物件状态变化正是 `hiddenAnchors` 那条链要的东西——没有它，40 秒只是一串画面 */
  it('要求至少一个物件有状态变化', () => {
    expect(p).toMatch(/at least one object a state change/)
  })

  it('要求刻意做出长短拍子的差别——全片一个长度就是没有设计', () => {
    expect(p).toMatch(/some want to be held long, some want to be a single cut/)
  })

  it('编剧类型与已有角色发出去，同一部剧才不会每集换一批人', () => {
    expect(p).toContain('中式都市情感')
    expect(p).toContain('林小满')
    const noGenre = scriptSystemPrompt({ ...input, genre: null, knownCharacters: [] })
    expect(noGenre, '没给就不发空段落').not.toMatch(/Genre and tone:/)
  })

  it('user prompt 只放素材，规矩全在 system 里', () => {
    const u = scriptUserPrompt(input)
    expect(u).toContain('<source>')
    expect(u).toMatch(/Write in the language of the source/)
  })
})

describe('scriptJsonSchema（发出去的那份）', () => {
  const wire = scriptJsonSchema()
  it('全必填 + 封死，且数值 bounds 被剃掉', () => {
    expect(wire['additionalProperties']).toBe(false)
    expect(wire['required']).toEqual(['title', 'scriptMd'])
    expect(JSON.stringify(wire)).not.toMatch(/"(minLength|maxLength)"/)
  })

  /** 场次标题是硬要求：S2 的拆解读它。没有结构的话拆解只能从散文里猜边界 */
  it('把 markdown 的场次结构要求写进 description——白名单只放行它', () => {
    const md = (wire['properties'] as Record<string, Record<string, unknown>>)['scriptMd']!
    expect(md['description']).toMatch(/## <number> · <place>/)
  })
})
