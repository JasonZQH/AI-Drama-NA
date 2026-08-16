/**
 * 生成 MockProvider 用的 fixture 视频。
 *
 * 刻意做到最小：480x854（9:16）、3 秒、极低码率——单个约 10–20 KB，
 * 七条加起来比一张截图还小。它们要进版本库，因为「无 GPU 无 key 五分钟
 * 跑通全链路」这条硬约束不能依赖开发者本地有 ffmpeg。
 *
 * 每条按景别配不同的视觉特征，好让人在分镜页上一眼看出 mock 没串号。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'control', 'fixtures')

// 景别 → [色相, 标注文字]。色相拉开距离，肉眼可辨
const SHOTS = {
  ecu: ['0x7c2d4a', 'ECU'],
  cu: ['0x2d4a7c', 'CU'],
  ms: ['0x2d7c4a', 'MS'],
  ws: ['0x7c6b2d', 'WS'],
  establishing: ['0x4a2d7c', 'EST'],
  ots: ['0x2d7c7c', 'OTS'],
  pov: ['0x7c3d2d', 'POV'],
}

mkdirSync(OUT, { recursive: true })

for (const [shotType, [color, label]] of Object.entries(SHOTS)) {
  const out = join(OUT, `${shotType}.mp4`)
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=480x854:d=3:r=24`,
    // 补静音轨：没有音轨的 clip 在 concat 时会音画错位（10-media-storage.md §2.2）
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    // -vf 是输出选项，必须排在全部 -i 之后，否则 ffmpeg 会把它当成后一个输入的选项
    '-vf',
    `drawtext=text='${label}':fontcolor=white:fontsize=64:x=(w-tw)/2:y=(h-th)/2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '40',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '32k',
    '-shortest',
    '-movflags',
    '+faststart',
    out,
  ])
  console.log(`✓ ${shotType}.mp4`)
}
console.log(`\n生成到 ${OUT}`)
