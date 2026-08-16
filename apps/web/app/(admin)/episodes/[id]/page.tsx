import EpisodeView from '@/components/EpisodeView'

export default async function EpisodePage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  return <EpisodeView episodeId={id} />
}
