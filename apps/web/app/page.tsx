import Dashboard, { DashboardNav } from '@/components/Dashboard'
import { Shell } from '@/components/Shell'

/**
 * 工作台。
 *
 * 项目与分集走真实路由并在新浏览器标签打开——所以这里不再有应用内标签栈。
 * 深链、后退、收藏、多显示器摊开，全部回到浏览器自己的能力上。
 */
export default function Home(): React.ReactElement {
  return (
    <Shell nav={<DashboardNav />}>
      <Dashboard />
    </Shell>
  )
}
