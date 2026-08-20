import { KeysView } from '@/components/KeysView'
import { Shell } from '@/components/Shell'
import { DashboardNav } from '@/components/Dashboard'

/**
 * 密钥页。挂在**全局**导航下而不是项目下——凭据是整套部署一份，
 * 不是每部剧一份。
 */
export default function KeysPage(): React.ReactElement {
  return (
    <Shell nav={<DashboardNav />}>
      <KeysView />
    </Shell>
  )
}
