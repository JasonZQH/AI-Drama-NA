'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { API } from './api'

/**
 * SSE 订阅（05-job-orchestration.md §7）。
 *
 * EventSource 自带断线重连，这是选 SSE 而非 WebSocket 的理由之一——
 * 不需要自己维护重连状态机。
 */
export type StudioEvent =
  | { type: 'shot.status'; shotId: string; status: string }
  | { type: 'job.progress'; jobId: string; shotId: string; pct: number; etaMs?: number }
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

/**
 * 外壳层的单条连接 + 前端分发。
 *
 * 多标签下每标签一条 EventSource 会让 Redis 订阅者随标签数线性增长，而事件
 * 本来就是全局广播的——分发放在前端做才对（web-admin-panel-design §3.1）。
 *
 * 返回值给顶栏显示连接状态：断线时用户要看得见，不能让界面装作数据还是新的。
 */
export function useEventBus(): { connected: boolean; subscribe: (fn: Listener) => () => void } {
  const [connected, setConnected] = useState(false)
  const listeners = useRef(new Set<Listener>())

  useEffect(() => {
    const es = new EventSource(`${API}/api/events`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)

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

  return { connected, subscribe }
}

type Listener = (e: StudioEvent) => void

const BusCtx = createContext<((fn: Listener) => () => void) | null>(null)

export const EventBusProvider = BusCtx.Provider

/** 面板订阅事件。回调存进 ref，所以传内联函数不会反复重订阅 */
export function useStudioEvent(onEvent: Listener): void {
  const subscribe = useContext(BusCtx)
  const cb = useRef(onEvent)
  cb.current = onEvent
  useEffect(() => {
    if (!subscribe) return
    return subscribe((e) => cb.current(e))
  }, [subscribe])
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
