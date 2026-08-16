import type { NextConfig } from 'next'

const config: NextConfig = {
  // 控制面在另一个端口。浏览器直接打它，控制面已开 CORS——
  // 不用 Next 的 rewrites 代理，媒体走 302 预签名时代理只会碍事
  env: { NEXT_PUBLIC_API_BASE: process.env['NEXT_PUBLIC_API_BASE'] ?? 'http://localhost:4000' },
}

export default config
