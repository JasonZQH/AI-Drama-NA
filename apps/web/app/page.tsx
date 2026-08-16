import Workspace from '@/components/Workspace'

/**
 * 管理面板的唯一入口。
 *
 * 标签栈是客户端状态而非路由——走路由会让 Next 卸载并重建整棵树，正好抵消
 * 「全挂载」的意义。深链由 URL hash 承载（见 lib/tabs.tsx）。
 */
export default function Home(): React.ReactElement {
  return <Workspace />
}
