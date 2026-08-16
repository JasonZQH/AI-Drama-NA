import { API } from '@/lib/api'
import Link from 'next/link'

interface Project {
  id: string
  title: string
  synopsis: string | null
  status: string
}

async function getProjects(): Promise<Project[]> {
  try {
    const r = await fetch(`${API}/api/projects`, { cache: 'no-store' })
    if (!r.ok) return []
    return ((await r.json()) as { projects: Project[] }).projects
  } catch {
    return []
  }
}

export default async function Home(): Promise<React.ReactElement> {
  const projects = await getProjects()

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-[24px] leading-8 font-medium">ai-drama-studio</h1>
      <p className="mb-8" style={{ color: 'var(--text-secondary)' }}>
        输入一个故事，输出可播放的分集短剧成片
      </p>

      {projects.length === 0 ? (
        /* 空态要给下一步动作，不能只是「暂无数据」（08 §8） */
        <div
          className="rounded-[10px] p-6"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          <p className="mb-2">还没有项目。</p>
          <p style={{ color: 'var(--text-secondary)' }}>
            运行 <code className="font-mono">pnpm db:seed</code> 载入示例项目（1 集 / 12 镜 / mock
            provider），第一分钟就能看到完整流程。
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}/storyboard`}
                className="block rounded-md p-4 transition-colors"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
              >
                <div className="font-medium">{p.title}</div>
                {p.synopsis && (
                  <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {p.synopsis}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
