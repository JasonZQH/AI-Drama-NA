import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ai-drama-studio',
  description: '本地优先的 AI 短剧生产系统',
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
