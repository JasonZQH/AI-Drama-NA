'use client'

import { RANGE_LABEL, usd, type RangeKey, type Timeseries, type TimeseriesPoint } from '@/lib/api'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useEffect, useRef, useState } from 'react'

gsap.registerPlugin(useGSAP)

/**
 * 趋势卡（设计规格 §4 / §7）。
 *
 * 本页唯一的编排时刻在这里：载入时曲线从左向右画出，**累计总花费的数字
 * 与曲线同步递增**，曲线到右端时数字恰好停在当前值。它不是装饰——那个
 * 数字就是这条曲线的积分，动效在陈述一件真事。
 *
 * 「同步」由结构保证：两个补间挂在同一条 timeline 的同一个位置（0），
 * 而不是靠两处 duration 凑出来的巧合。
 */

const RANGES: readonly RangeKey[] = ['30d', '3m', '6m', '1y', 'all']

const GRANULARITY: Record<Timeseries['granularity'], string> = {
  day: '按日',
  week: '按周',
  month: '按月',
}

/**
 * 绘图区，单位是 viewBox 用户坐标。
 *
 * **宽度实测、不等比缩放。** 早先 `viewBox="0 0 620 180" class="w-full"` 会让
 * 图随页宽等比放大——1400px 宽的窗口下高度变成 400px，一屏就装不下了。改为
 * 把容器实测宽度直接当 viewBox 宽度（1:1），高度钉死；这样既不失真，
 * getTotalLength() 与 strokeDasharray 也仍在同一套单位里。
 */
const VB_H = 132
const PAD = { l: 46, r: 46, t: 14, b: 24 }
const MIN_W = 320

/** 月粒度时 x 轴只到「年-月」——日号在按月聚合下是噪音 */
function tickLabel(at: string, g: Timeseries['granularity']): string {
  const [y = '', m = '', d = ''] = at.split('-')
  return g === 'month' ? `${y}-${m}` : `${m}-${d}`
}

/** 一次通过率：首次尝试即被采用的比例。分子由后端给（accepted 且 attempt=1） */
const passRate = (p: TimeseriesPoint): number => (p.attempts > 0 ? p.firstPass / p.attempts : 0)

export interface TrendChartProps {
  data: Timeseries | null
  range: RangeKey
  onRangeChange: (r: RangeKey) => void
  /** 累计总花费的 DOM 节点。它与曲线共用一条 timeline，所以得由外部把节点交进来 */
  totalRef: React.RefObject<HTMLDivElement | null>
  /** null = 还没拿到 overview。拿到之前不起编排，否则数字会停在 0 */
  totalMicroUsd: number | null
  /** 编排结束（或确定不会跑）时通知外部把这一格交回给 React 渲染 */
  onSettled?: () => void
}

export function TrendChart({
  data,
  range,
  onRangeChange,
  totalRef,
  totalMicroUsd,
  onSettled,
}: TrendChartProps): React.ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const svgBox = useRef<HTMLDivElement>(null)
  const [vbW, setVbW] = useState(760)
  const costRef = useRef<SVGPathElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  // 编排只属于「载入」这一刻；之后切区间是查询行为，静态呈现即可
  const played = useRef(false)

  useEffect(() => {
    const el = svgBox.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0
      // 宽度 0 说明容器被隐藏了，别拿它去重排
      if (w > 0) setVbW(Math.max(MIN_W, Math.round(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const PLOT = { l: PAD.l, r: vbW - PAD.r, t: PAD.t, b: VB_H - PAD.b }

  const pts = data?.points ?? []
  const n = pts.length
  const maxCost = Math.max(1, ...pts.map((p) => p.costMicroUsd))

  const x = (i: number): number =>
    n === 1 ? (PLOT.l + PLOT.r) / 2 : PLOT.l + (i / (n - 1)) * (PLOT.r - PLOT.l)
  const yCost = (v: number): number => PLOT.b - (v / maxCost) * (PLOT.b - PLOT.t)
  const yRate = (v: number): number => PLOT.b - v * (PLOT.b - PLOT.t)
  const line = (fy: (p: TimeseriesPoint) => number): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${fy(p).toFixed(1)}`).join(' ')

  const dCost = line((p) => yCost(p.costMicroUsd))
  const dRate = line((p) => yRate(passRate(p)))
  const last = pts[n - 1]

  useGSAP(
    () => {
      const path = costRef.current
      // 已经播过就把这一格交还给 React。少了这一句，resize 触发的重跑会
      // 直接 return，数字永远停在被打断的那一帧上
      if (played.current) {
        onSettled?.()
        return
      }
      /*
       * 编排跑不成时要交还这一格，否则「总花费」会永远停在空白上。
       * 触发条件是没有曲线可画（无数据）或总额还没到——后者只是还没轮到，
       * 所以只有前者才算「不会再跑了」。
       */
      if (!path || n === 0) {
        onSettled?.()
        return
      }
      if (totalMicroUsd === null) return
      played.current = true

      const num = totalRef.current
      const len = path.getTotalLength()
      const mm = gsap.matchMedia()

      mm.add(
        { reduce: '(prefers-reduced-motion: reduce)', full: '(prefers-reduced-motion: no-preference)' },
        (ctx) => {
          // reduce 下是「直接呈现终态」，不是「快一点的动画」（07 §8）
          const dur = ctx.conditions?.['reduce'] === true ? 0 : 1.1
          const tl = gsap.timeline()

          tl.fromTo(
            path,
            { strokeDasharray: len, strokeDashoffset: len },
            { strokeDashoffset: 0, duration: dur, ease: 'none' },
            0,
          )

          if (num) {
            const c = { v: 0 }
            // onComplete 兜底：duration 0 时 onUpdate 不保证被调用
            const write = (): void => {
              num.textContent = usd(c.v)
            }
            tl.to(
              c,
              {
                v: totalMicroUsd,
                duration: dur,
                ease: 'none',
                onUpdate: write,
                // 数完把这一格交还给 React，之后 SSE 刷新才写得进去
                onComplete: () => {
                  write()
                  // 清掉内联 dash：路径会随窗口宽度重算，旧的 dasharray
                  // 一旦短于新路径就会把实线画成虚线
                  gsap.set(path, { clearProps: 'strokeDasharray,strokeDashoffset' })
                  onSettled?.()
                },
              },
              0,
            )
          } else {
            onSettled?.()
          }

          if (dotRef.current) tl.from(dotRef.current, { autoAlpha: 0, duration: dur * 0.2 }, dur * 0.8)
        },
      )

      return () => mm.revert()
    },
    /*
     * 依赖只挂「数据到没到」，不挂曲线形状。
     *
     * dCost 会随窗口宽度重算（viewBox 宽度是实测的），挂上去就等于每次 resize
     * 都重跑一次编排；配 revertOnUpdate 更会把跑到一半的补间直接杀掉，数字
     * 就永远停在中途——实测就是这么停在 $0.00 的。
     */
    { scope: root, dependencies: [totalMicroUsd, n > 0] },
  )

  return (
    <section
      ref={root}
      className="rounded-[10px] px-3 py-2"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <h2 className="text-[13px] font-medium">趋势</h2>
        {data && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {GRANULARITY[data.granularity]} · <span className="tnum">{n}</span> 个点
          </span>
        )}
        <span className="flex-1" />
        <div className="flex gap-1" role="group" aria-label="时间区间">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange(r)}
              aria-pressed={r === range}
              className="rounded-sm px-2 py-1 text-[11px]"
              style={{
                background: r === range ? 'var(--accent-subtle)' : 'transparent',
                color: r === range ? 'var(--accent-text)' : 'var(--text-secondary)',
                border: `1px solid ${r === range ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {/* 两条曲线共用纵向空间但量纲不同，所以左右各标一次刻度 */}
      <div className="mb-1 flex flex-wrap items-center gap-4 text-[11px]">
        <span className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
          <svg width="14" height="8" aria-hidden>
            <line x1="0" y1="4" x2="14" y2="4" stroke="var(--chart-1)" strokeWidth="2" />
          </svg>
          每日花费（左轴）
        </span>
        <span className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
          <svg width="14" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="14"
              y2="4"
              stroke="var(--chart-2)"
              strokeWidth="2"
              strokeDasharray="3 2"
            />
          </svg>
          一次通过率（右轴）
        </span>
        {last && (
          <span className="tnum" style={{ color: 'var(--text-muted)' }}>
            最新 {last.at} · {usd(last.costMicroUsd)} · 通过率 {Math.round(passRate(last) * 100)}%
          </span>
        )}
      </div>

      <div ref={svgBox} className="w-full">
        {n === 0 ? (
          /* 空态给下一步动作，不能只说「暂无数据」（验收 §10） */
          <div
            className="rounded-md p-4 text-center text-[12px]"
            style={{ background: 'var(--bg-inset)', color: 'var(--text-secondary)', height: VB_H }}
          >
            <p>这个区间内还没有生成记录。</p>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              到下方任一项目里生成一集，曲线与成本就会出现在这里；或把区间切到「全部」看历史。
            </p>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${vbW} ${VB_H}`}
            width={vbW}
            height={VB_H}
            className="block"
            role="img"
            aria-label={`每日花费与一次通过率趋势，${RANGE_LABEL[range]}，共 ${n} 个数据点`}
          >
            <line x1={PLOT.l} y1={PLOT.t} x2={PLOT.r} y2={PLOT.t} stroke="var(--border)" strokeWidth="1" />
            <line
              x1={PLOT.l}
              y1={PLOT.b}
              x2={PLOT.r}
              y2={PLOT.b}
              stroke="var(--border-strong)"
              strokeWidth="1"
            />

            <text
              className="tnum"
              x={PLOT.l - 6}
              y={PLOT.t + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {usd(maxCost)}
            </text>
            <text
              className="tnum"
              x={PLOT.l - 6}
              y={PLOT.b + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-muted)"
            >
              $0
            </text>
            <text className="tnum" x={PLOT.r + 6} y={PLOT.t + 4} fontSize="10" fill="var(--text-muted)">
              100%
            </text>
            <text className="tnum" x={PLOT.r + 6} y={PLOT.b + 4} fontSize="10" fill="var(--text-muted)">
              0%
            </text>

            <path d={dRate} fill="none" stroke="var(--chart-2)" strokeWidth="1.5" strokeDasharray="4 3" />
            <path
              ref={costRef}
              d={dCost}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {last && (
              <circle
                ref={dotRef}
                cx={x(n - 1)}
                cy={yCost(last.costMicroUsd)}
                r="3.5"
                fill="var(--chart-1)"
              />
            )}

            {tickIndexes(n).map((i) => {
              const p = pts[i]
              if (!p) return null
              return (
                <text
                  key={p.at}
                  x={x(i)}
                  y={VB_H - 6}
                  fontSize="10"
                  fill="var(--text-muted)"
                  textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                >
                  {tickLabel(p.at, data?.granularity ?? 'day')}
                </text>
              )
            })}
          </svg>
        )}
      </div>
    </section>
  )
}

/** 最多 5 个 x 轴刻度：标满了在一张卡片宽度里就成了糊在一起的灰条 */
function tickIndexes(n: number): number[] {
  if (n <= 5) return Array.from({ length: n }, (_, i) => i)
  return Array.from({ length: 5 }, (_, k) => Math.round((k * (n - 1)) / 4))
}
