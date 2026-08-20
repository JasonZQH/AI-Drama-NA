'use client'

import { PageHeader } from '@/components/Shell'
import { api } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'

/**
 * 提示词底座。**只读。**
 *
 * 「基础 prompt 在哪里配置」的答案是「在代码里」，这一页不改变那件事——它让
 * 那件事**看得见**：不用读 TypeScript 就知道系统到底发出去什么，以及要改的话
 * 该动哪个文件。
 *
 * 为什么不做成可编辑：底座措辞由单测钉着（`prompt.test.ts` 13 条断言的就是这三张
 * 散文映射表与装配语序）。搬进数据库之后，测试测的是一份不生效的值，而生效的
 * 那份没人守。真到了需要非工程师频繁调措辞那天再谈——那时要连测试一起搬。
 *
 * 可变正文（风格 / 角色 / 地点 / 动作）本来就在库里，那半边在资产页改。
 */

interface Prompts {
  shotlist: {
    model: string
    source: string
    renderedWith: { scenes: number; targetDurationSec: number }
    system: string
    criteria: {
      source: string
      shotCount: { min: number; max: number }
      durationTolerancePct: number
      maxCastPerShot: number
      sameShotTypeRun: number
    }
  }
  video: {
    source: string
    prose: {
      shotType: Record<string, string>
      cameraMove: Record<string, string>
      timeOfDay: Record<string, string>
    }
    assembly: string[]
    negativeFrom: string
  }
}

export function PromptsView(): React.ReactElement {
  const [d, setD] = useState<Prompts | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setD(await api<Prompts>('/api/prompts'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    document.title = '提示词 · ai-drama-studio'
  }, [])

  return (
    <>
      <PageHeader
        title="提示词底座"
        subtitle="只读。改措辞要改代码——单测钉着这些常量，搬进库会让测试测一份不生效的值"
      >
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          刷新
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {err && (
          <div
            className="rounded-md px-3 py-2 text-[12px]"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
          >
            ✕ {err}
          </div>
        )}

        {d && (
          <>
            <Card title="分镜 · system prompt" source={d.shotlist.source} extra={d.shotlist.model}>
              <p className="mb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                它是输入的函数。下面这份按 {d.shotlist.renderedWith.scenes} 场 /{' '}
                {d.shotlist.renderedWith.targetDurationSec} 秒渲染——<strong>你那一集的实际值会不同</strong>
                ，场次数与目标时长会插进去。
              </p>
              <pre
                className="whitespace-pre-wrap rounded-md p-2.5 font-mono text-[12px] leading-5"
                style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)' }}
              >
                {d.shotlist.system}
              </pre>
            </Card>

            <Card title="判据常量" source={d.shotlist.criteria.source}>
              <p className="mb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                上面那段硬规则里的数字全部取自这里，不是另写一遍。改一个常量， 提示词与校验器同时变。
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
                <Row k="镜头数">
                  {d.shotlist.criteria.shotCount.min}–{d.shotlist.criteria.shotCount.max}
                </Row>
                <Row k="时长容差">±{d.shotlist.criteria.durationTolerancePct}%</Row>
                <Row k="单镜最多角色">{d.shotlist.criteria.maxCastPerShot}</Row>
                <Row k="连续同景别告警">{d.shotlist.criteria.sameShotTypeRun}</Row>
              </dl>
            </Card>

            <Card title="视频 prompt · 装配规则" source={d.video.source}>
              <ol className="ml-4 list-decimal text-[12px] leading-6">
                {d.video.assembly.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ol>
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                负向词来自 <code className="font-mono">{d.video.negativeFrom}</code>
              </p>
            </Card>

            <Card title="缩写 → 散文" source={d.video.source}>
              <p className="mb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <code className="font-mono">cu</code> 对模型不是词。这三张表把枚举展开成模型认得的英文。
              </p>
              <div className="grid gap-4 md:grid-cols-3">
                <Prose title="景别" map={d.video.prose.shotType} />
                <Prose title="运镜" map={d.video.prose.cameraMove} />
                <Prose title="时段" map={d.video.prose.timeOfDay} />
              </div>
            </Card>

            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              想看某一镜<strong>实际</strong>会发出去什么（含角色/地点/风格），去分集页点开那个镜头，
              抽屉顶部的「Prompt 检视器」就是它——不花钱、不入队。
            </p>
          </>
        )}
      </div>
    </>
  )
}

function Card({
  title,
  source,
  extra,
  children,
}: {
  title: string
  source: string
  extra?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section
      className="rounded-md p-3"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {extra && (
          <code className="font-mono text-[11px]" style={{ color: 'var(--accent-text)' }}>
            {extra}
          </code>
        )}
        <div className="flex-1" />
        {/* 要改就去改这个文件——这一页存在的一半理由 */}
        <code className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {source}
        </code>
      </div>
      {children}
    </section>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
      <dd className="tnum">{children}</dd>
    </>
  )
}

function Prose({ title, map }: { title: string; map: Record<string, string> }): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {Object.entries(map).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono" style={{ color: 'var(--text-muted)' }}>
              {k}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
