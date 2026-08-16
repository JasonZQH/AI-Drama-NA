import AssetsView from '@/components/AssetsView'
import { ProjectShell } from '@/components/ProjectShell'

/**
 * 资产单独一页。
 *
 * 原来它挂在项目页底下，两块内容叠起来必然要滚——而「一页不超过一屏」是硬
 * 约束。拆开后分集列表与资产各自占满一屏，侧边栏负责在两者间跳。
 */
export default async function AssetsPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  return (
    <ProjectShell projectId={id} active="assets">
      <AssetsView projectId={id} />
    </ProjectShell>
  )
}
