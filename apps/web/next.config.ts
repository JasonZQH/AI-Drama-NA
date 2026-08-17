import type { NextConfig } from 'next'

const config: NextConfig = {
  // 控制面在另一个端口。浏览器直接打它，控制面已开 CORS——
  // 不用 Next 的 rewrites 代理，媒体走 302 预签名时代理只会碍事
  env: {
    NEXT_PUBLIC_API_BASE: process.env['NEXT_PUBLIC_API_BASE'] ?? 'http://localhost:4000',
    /*
     * 变更请求要带的头（控制面 server.ts 的 guardWrites）。
     *
     * 它会进浏览器包，所以**不是**一个能对本机用户保密的秘密。默认配置下
     * 挡住攻击的是「自定义头强制预检 + 控制面只听 127.0.0.1」，不是这个值本身。
     * 它的秘密性只在显式设了 CONTROL_HOST=0.0.0.0 把控制面暴露到局域网时才起作用，
     * 那种场景下这个前端也不该是唯一的调用方。
     */
    NEXT_PUBLIC_CONTROL_API_KEY: process.env['CONTROL_API_KEY'] ?? '',
  },
}

export default config
