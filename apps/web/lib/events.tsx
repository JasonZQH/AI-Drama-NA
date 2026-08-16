'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { API } from './api'

/**
 * SSE 订阅（05-job-orchestration.md §7）。
 *
 * EventSource 自带断线重连，这是选 SSE 而非 WebSocket 的理由之一——
 * 不需要自己维护重连状态机。
 */
export type StudioEvent =
  | { type: 'shot.status'; shotId: string; status: string }
  | {
      type: 'job.progress'
      jobId: string
      shotId: string
      pct: number
      etaMs?: number
      /** contracts 的 GenStage：queued | loading_model | denoising | decoding | uploading */
      stage?: string
    }
  | { type: 'take.created'; shotId: string; takeId: string; thumbUrl: string }
  | { type: 'batch.progress'; episodeId: string; done: number; total: number; failed: number }
  | { type: 'cost.updated'; projectId: string; spentMicroUsd: number }
  | { type: 'error'; shotId?: string; code: string; message: string }

const TYPES: StudioEvent['type'][] = [
  'shot.status',
  'job.progress',
  'take.created',
  'batch.progress',
  'cost.updated',
  'error',
]

type Listener = (e: StudioEvent) => void

interface Bus {
  readonly connected: boolean
  subscribe(fn: Listener): () => void
}

const BusCtx = createContext<Bus | null>(null)

/**
 * 每个浏览器标签一条 EventSource，前端分发给所有订阅者。
 *
 * **provider 必须挂在根 layout，不能挂在 Shell 里。** 分集页自己渲染 Shell，
 * 于是它调 useStudioEvent 的位置在 provider 之上，context 读到 null，事件
 * 一条也收不到——进度条因此完全不动。这个坑踩过一次：SSE 明明在传（curl 能
 * 看到 job.progress），界面却毫无反应。把 provider 提到树根就不会再有上下之分。
 */
export function EventBusProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [connected, setConnected] = useState(false)
  const listeners = useRef(new Set<Listener>())

  useEffect(() => {
    const es = new EventSource(`${API}/api/events`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false) // EventSource 会自行重连

    const handlers = TYPES.map((t) => {
      const h = (ev: MessageEvent<string>): void => {
        let parsed: StudioEvent
        try {
          parsed = JSON.parse(ev.data) as StudioEvent
        } catch {
          return // 单条坏消息不该拖垮订阅
        }
        for (const fn of listeners.current) fn(parsed)
      }
      es.addEventListener(t, h as EventListener)
      return [t, h] as const
    })

    return () => {
      for (const [t, h] of handlers) es.removeEventListener(t, h as EventListener)
      es.close()
    }
  }, [])

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])

  const value = useMemo<Bus>(() => ({ connected, subscribe }), [connected, subscribe])
  return <BusCtx.Provider value={value}>{children}</BusCtx.Provider>
}

/** 顶栏用：断线时用户要看得见，不能让界面装作数据还是新的 */
export function useEventBus(): Bus {
  return useContext(BusCtx) ?? { connected: false, subscribe: () => () => undefined }
}

/** 面板订阅事件。回调存进 ref，所以传内联函数不会反复重订阅 */
export function useStudioEvent(onEvent: Listener): void {
  const bus = useContext(BusCtx)
  const cb = useRef(onEvent)
  cb.current = onEvent
  useEffect(() => {
    if (!bus) return
    return bus.subscribe((e) => cb.current(e))
  }, [bus])
}

export function useStudioEvents(projectId: string | null, onEvent: (e: StudioEvent) => void): boolean {
  const [connected, setConnected] = useState(false)
  // 用 ref 存回调，避免每次父组件重渲染都重建连接
  const cb = useRef(onEvent)
  cb.current = onEvent

  useEffect(() => {
    if (!projectId) return
    const es = new EventSource(`${API}/api/projects/${projectId}/events`)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false) // EventSource 会自行重连

    const handlers = TYPES.map((t) => {
      const h = (ev: MessageEvent<string>): void => {
        try {
          cb.current(JSON.parse(ev.data) as StudioEvent)
        } catch {
          // 单条坏消息不该拖垮订阅
        }
      }
      es.addEventListener(t, h as EventListener)
      return [t, h] as const
    })

    return () => {
      for (const [t, h] of handlers) es.removeEventListener(t, h as EventListener)
      es.close()
    }
  }, [projectId])

  return connected
}
