import { z } from 'zod'
import { toWireSchema } from './wire.js'

/**
 * 素材 → 剧本**提案**（S1）。
 *
 * ## 为什么需要它
 *
 * `episodes.script_md` 此前**只有人能写**：面板上粘一段进去，没有第二条路。于是
 * 整条流水线的第一环是纯人工的，而后面每一环（S2 场次、S3 分镜）都已经是
 * 「LLM 定、人复验」。
 *
 * 真实用法是「我手上有一部小说/一个梗概/一段素材，我要把它改成一集竖屏短剧」——
 * 而不是「我先自己写一集短剧」。把 S1 留成人工，等于要求用户先完成最难的那一步，
 * 系统只帮他做后面容易的。
 *
 * ## 提案，不是写入
 *
 * 与 `breakdown` 同一个立场：回一份草稿，人在剧本抽屉里改、保存了才算数。剧本是
 * 作者的东西，系统该起草不该代笔。
 *
 * ## 为什么只有两个字段
 *
 * `logline` / `hook` / `cliffhanger` 归 `breakdown`——它读**成稿的剧本**推那三行，
 * 比在这一步一边编故事一边总结自己更准。两处都产会漂，而漂开时没有任何东西
 * 判得出哪一份是对的。
 */
export const scriptDraft = () =>
  z.strictObject({
    title: z.string().min(1).describe('这一集的标题，短句，不是概括'),
    /**
     * markdown。**场次标题是硬要求**——S2 的拆解读它，`## 一 · 玄关` 这种结构能让
     * 拆解直接对上；没有结构的话拆解只能从散文里猜场次边界。
     */
    scriptMd: z
      .string()
      .min(200)
      .describe(
        'The full script in markdown. Head every scene with `## <number> · <place>` followed by a slugline line (interior/exterior, place, time). Then action paragraphs and dialogue. Dialogue lines are `**NAME**：line`.',
      ),
  })

export type ScriptDraft = z.infer<ReturnType<typeof scriptDraft>>

export function scriptJsonSchema(): Record<string, unknown> {
  return toWireSchema(scriptDraft())
}
