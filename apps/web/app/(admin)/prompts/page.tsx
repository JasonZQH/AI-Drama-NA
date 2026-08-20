import { PromptsView } from '@/components/PromptsView'
import { Shell } from '@/components/Shell'
import { DashboardNav } from '@/components/Dashboard'

/**
 * 提示词底座。挂全局导航下——它是整套部署一份，不是每部剧一份。
 */
export default function PromptsPage(): React.ReactElement {
  return (
    <Shell nav={<DashboardNav />}>
      <PromptsView />
    </Shell>
  )
}
