import ProjectView from '@/components/ProjectView'
import { ProjectShell } from '@/components/ProjectShell'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  return (
    <ProjectShell projectId={id} active="episodes">
      <ProjectView projectId={id} />
    </ProjectShell>
  )
}
