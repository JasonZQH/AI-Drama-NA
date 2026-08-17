#!/usr/bin/env node
/**
 * 拿到第一把真 key 之后、跑整集之前，先用它回答几个只能实测的问题。
 *
 *   OPENROUTER_API_KEY=sk-... node scripts/probe-openrouter.mjs
 *
 * 会花钱：**一次生成**（默认最便宜的档，约 $0.12）。它买的是几条写不进代码的
 * 事实——每一条错了都会在真跑整集时以更贵的方式暴露。
 *
 * 之所以是一个脚本而不是测试：测试要能反复跑且不烧钱，而这些问题每人只需要
 * 回答一次，答案写进 openrouter.ts 的注释里。
 */

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('需要 OPENROUTER_API_KEY')
  process.exit(1)
}

const BASE = 'https://openrouter.ai/api/v1'
const MODEL = process.env.PROBE_MODEL ?? 'google/veo-3.1-lite'
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }

const log = (q, a) => console.log(`\n■ ${q}\n  → ${a}`)

// ── 1. 提交，看真实响应码与响应体 ──────────────────────────────
const submit = await fetch(`${BASE}/videos`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    model: MODEL,
    prompt: 'a paper boat drifting on still water, overhead shot',
    duration: 4,
    resolution: '720p',
    aspect_ratio: '9:16',
    generate_audio: false,
  }),
})
const submitBody = await submit.json()
log('POST /videos 的状态码与响应体', `HTTP ${submit.status} · ${JSON.stringify(submitBody)}`)
if (!submit.ok) process.exit(1)
const id = submitBody.id

// ── 2. 重复提交同一内容会不会被去重（有没有请求级幂等）─────────
const again = await fetch(`${BASE}/videos`, {
  method: 'POST',
  headers: { ...H, 'idempotency-key': id, 'x-openrouter-idempotency-key': id },
  body: JSON.stringify({
    model: MODEL,
    prompt: 'a paper boat drifting on still water, overhead shot',
    duration: 4,
    resolution: '720p',
    aspect_ratio: '9:16',
    generate_audio: false,
  }),
})
const againBody = await again.json()
log(
  '带 Idempotency-Key 重复提交会拿回同一个 job 吗',
  againBody.id === id ? '会——存在请求级幂等' : `不会（新 id ${againBody.id}）——幂等只能靠编排层`,
)

// ── 3. cancel 端点到底存不存在 ────────────────────────────────
for (const [method, path] of [
  ['POST', `/videos/${id}/cancel`],
  ['DELETE', `/videos/${id}`],
]) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H })
  log(
    `${method} ${path}`,
    `HTTP ${r.status}${r.status === 404 ? '（不存在，与文档一致）' : ' ← 意外，值得跟进'}`,
  )
}

// ── 4. 轮询到终态，看状态流转与 usage ──────────────────────────
let last
const deadline = Date.now() + 15 * 60_000
for (;;) {
  const r = await fetch(`${BASE}/videos/${id}`, { headers: H })
  last = await r.json()
  if (last.status !== 'pending' && last.status !== 'in_progress') break
  if (Date.now() > deadline) {
    log('轮询', '15 分钟未终态，放弃')
    process.exit(1)
  }
  await new Promise((s) => setTimeout(s, 5000))
}
log('终态响应体', JSON.stringify(last))
log(
  'usage.cost 有没有回报',
  last.usage?.cost !== undefined ? `有：$${last.usage.cost}` : '没有 ← 成本要自己估',
)

// ── 5. **最要紧的一条**：产物 URL 需不需要鉴权 ─────────────────
//
// 字段名叫 unsigned_urls，而文档的下载示例带着 Authorization。queue/ingest.ts
// 的 materialize 是裸 fetch，如果这里要鉴权，第一次接真 key 就会 401。
const url = last.unsigned_urls?.[0]
if (url) {
  const bare = await fetch(url, { method: 'GET' })
  const authed = await fetch(url, { method: 'GET', headers: { authorization: H.authorization } })
  log(
    '产物 URL 不带鉴权头能下吗（决定 ingest 要不要改）',
    `裸请求 HTTP ${bare.status} · 带 Bearer HTTP ${authed.status}` +
      (bare.ok ? '\n  → 不需要鉴权，ingest 现状可用' : '\n  → 需要鉴权，ingest 的 materialize 必须能带头'),
  )
  log('content-length', bare.headers.get('content-length') ?? authed.headers.get('content-length') ?? '未给')
}

console.log('\n把上面的答案写回 apps/control/src/providers/openrouter.ts 的注释。')
