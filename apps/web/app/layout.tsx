import type { Metadata } from 'next'
import { EventBusProvider } from '@/lib/events'
import './globals.css'

export const metadata: Metadata = {
  title: 'ai-drama-studio',
  description: '本地优先的 AI 短剧生产系统',
}

/**
 * SSE 的 provider 挂在树根。
 *
 * 挂在 Shell 里会出事：分集页自己渲染 Shell，它调 useStudioEvent 的位置就在
 * provider 之上，context 读到 null，进度事件一条也收不到——而 SSE 明明在传。
 * 挂在根上就不存在上下之分。
 */
export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="zh-CN">
      <body>
        <EventBusProvider>{children}</EventBusProvider>
      </body>
    </html>
  )
}
