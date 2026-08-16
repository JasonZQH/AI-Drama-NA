'use client'

import { useEffect, useRef, useState } from 'react'
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
