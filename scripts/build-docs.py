#!/usr/bin/env python3
"""
ai-drama-studio · 文档构建脚本

把 docs/_src/*.md 渲染成带设计的 HTML。设计令牌见 docs/assets/docs.css，
与 docs/07-design-system.md 定义的项目设计系统保持一致。

用法:  python3 scripts/build-docs.py
依赖:  pip install markdown pymdown-extensions beautifulsoup4
"""

from __future__ import annotations

import html
import re
import sys
from pathlib import Path

import markdown
from bs4 import BeautifulSoup, NavigableString

# ---------------------------------------------------------------- 配置

SRC_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("docs/_src")
OUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("docs")

BRAND = "ai-drama-studio"

# 侧栏分组：(组名, [文档编号...])
GROUPS = [
    ("基础",       ["00", "01"]),
    ("数据与流程",  ["02", "03"]),
    ("生成层",      ["04", "05", "06"]),
    ("前端",        ["07", "08"]),
    ("工程落地",    ["09", "10", "11", "12"]),
    ("生成质量",    ["13"]),
]

# 索引页每篇的一句话说明
BLURBS = {
    "00": "范围定义、八条设计约束、全项目统一术语表",
    "01": "三平面架构、进程拓扑、monorepo 目录结构",
    "02": "数据库 schema、状态枚举、Generation Ledger",
    "03": "八阶段流水线、镜头状态机、评测分层、连续性策略",
    "04": "生成后端统一契约、能力声明与路由器",
    "05": "队列拓扑、并发控制、轮询、重试、成本记账、崩溃恢复",
    "06": "控制面 REST + SSE 接口与错误规范",
    "07": "色彩令牌、排版、组件清单、交互模式与可访问性",
    "08": "七个页面的布局、交互与空态规格",
    "09": "Worker Contract、模型选型与许可、远程 GPU 部署",
    "10": "S3 存储、FFmpeg 拼接、TTS、HLS、容量估算",
    "11": "环境搭建、环境变量、联调检查、排错速查",
    "12": "M0–M6 里程碑、验收标准与关键指标",
    "13": "角色资产三路分离、参考图机制、单镜头 prompt 三阶段",
}

SVG_SUN = ('<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
           'stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/>'
           '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2'
           'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>')
SVG_MOON = ('<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>')
SVG_MENU = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
            'stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>')

# 判定「这是 ASCII 图而非代码」的字符
DIAGRAM_CHARS = set("─│┌┐└┘├┤┬┴┼━┃▌▐▓░█◀▶▲▼→←↑↓↔⏎")

INLINE_DOC_RE = re.compile(r"^(?:docs/)?(\d{2}-[a-z0-9-]+)\.md(\s*§.*)?$")


# ---------------------------------------------------------------- 工具

def slugify(text: str) -> str:
    """生成 URL 安全且对中文友好的锚点 id。"""
    text = text.strip().lower()
    text = re.sub(r"[^\w一-鿿 §·.-]+", "", text)
    text = re.sub(r"[\s·]+", "-", text)
    return text.strip("-") or "section"


def looks_like_diagram(code: str) -> bool:
    return any(ch in DIAGRAM_CHARS for ch in code)


# ---------------------------------------------------------------- 解析

class Doc:
    def __init__(self, path: Path):
        self.path = path
        self.stem = path.stem                    # 00-overview
        self.num = self.stem[:2]                 # 00
        self.href = f"{self.stem}.html"
        raw = path.read_text(encoding="utf-8")

        m = re.match(r"^#\s+(.+?)\s*$", raw.split("\n", 1)[0])
        head = m.group(1) if m else self.stem
        # "00 · 项目总览与范围定义" -> ("00", "项目总览与范围定义")
        parts = head.split("·", 1)
        self.title = parts[1].strip() if len(parts) == 2 else head
        self.body_md = raw.split("\n", 1)[1] if m else raw

        self.html = ""
        self.has_mermaid = False
        self.toc: list[tuple[int, str, str]] = []   # (level, id, text)


def render(doc: Doc, docs_by_num: dict[str, Doc]) -> None:
    md = markdown.Markdown(
        extensions=[
            "tables",
            "fenced_code",
            "sane_lists",
            "attr_list",
            "pymdownx.tasklist",
            "pymdownx.tilde",
        ],
        extension_configs={"pymdownx.tasklist": {"custom_checkbox": False}},
    )
    soup = BeautifulSoup(md.convert(doc.body_md), "html.parser")

    # --- 标题：加 id、锚点链接、收集 TOC ---
    seen: dict[str, int] = {}
    for tag in soup.find_all(["h2", "h3", "h4"]):
        text = tag.get_text().strip()
        base = slugify(text)
        seen[base] = seen.get(base, 0) + 1
        hid = base if seen[base] == 1 else f"{base}-{seen[base]}"
        tag["id"] = hid
        if tag.name in ("h2", "h3"):
            doc.toc.append((int(tag.name[1]), hid, text))
        a = soup.new_tag("a", href=f"#{hid}")
        a["class"] = "anchor"
        a["aria-label"] = "链接到此节"
        a.string = "#"
        tag.append(a)

    # --- 代码块：包壳 + 语言标签 + 图表识别 ---
    for pre in soup.find_all("pre"):
        code = pre.find("code")
        if code is None:
            continue
        classes = code.get("class") or []
        lang = ""
        for c in classes:
            if c.startswith("language-"):
                lang = c[len("language-"):]
                break
        text = code.get_text()

        # Mermaid：交给浏览器端渲染成矢量图
        if lang == "mermaid":
            wrap = soup.new_tag("figure")
            wrap["class"] = "diagram"
            holder = soup.new_tag("div")
            holder["class"] = "mermaid"
            holder.string = text
            wrap.append(holder)
            pre.replace_with(wrap)
            doc.has_mermaid = True
            continue

        is_diagram = not lang and looks_like_diagram(text)

        wrapper = soup.new_tag("div")
        wrapper["class"] = "codeblock" + (" is-diagram" if is_diagram else "")
        pre.wrap(wrapper)
        if lang:
            tag = soup.new_tag("span")
            tag["class"] = "lang"
            tag.string = lang
            wrapper.insert(0, tag)

    # --- 表格：横向滚动容器 ---
    for table in soup.find_all("table"):
        wrap = soup.new_tag("div")
        wrap["class"] = "table-wrap"
        table.wrap(wrap)

    # --- 行内 `03-pipeline.md` 自动转成链接 ---
    for code in soup.find_all("code"):
        if code.find_parent("pre") or code.find_parent("a"):
            continue
        m = INLINE_DOC_RE.match(code.get_text().strip())
        if not m:
            continue
        target = docs_by_num.get(m.group(1)[:2])
        if not target or target.stem == doc.stem:
            continue
        a = soup.new_tag("a", href=target.href)
        a["title"] = target.title
        code.wrap(a)

    doc.html = str(soup)


# ---------------------------------------------------------------- 模板

def nav_html(docs_by_num: dict[str, Doc], current: str | None) -> str:
    out = []
    for label, nums in GROUPS:
        out.append('<div class="nav-group">')
        out.append(f'<div class="label">{label}</div>')
        for n in nums:
            d = docs_by_num.get(n)
            if not d:
                continue
            cls = "nav-item active" if d.num == current else "nav-item"
            out.append(
                f'<a class="{cls}" href="{d.href}">'
                f'<span class="num">{d.num}</span><span>{html.escape(d.title)}</span></a>'
            )
        out.append("</div>")
    out.append(
        '<div class="extra">'
        '<a class="nav-item" href="../README.md"><span class="num">↩</span><span>README</span></a>'
        '<a class="nav-item" href="adr/"><span class="num">ADR</span><span>架构决策记录</span></a>'
        "</div>"
    )
    return "\n".join(out)


MERMAID_JS = """
<script src="assets/mermaid.min.js"></script>
<script>
(function () {
  if (typeof mermaid === 'undefined') return;
  var FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  var DARK = {
    background: 'transparent',
    primaryColor: '#1d1d21', primaryTextColor: '#f2f2f0', primaryBorderColor: '#3a3a42',
    secondaryColor: '#16233a', secondaryTextColor: '#f2f2f0', secondaryBorderColor: '#2a4a72',
    tertiaryColor: '#151518', tertiaryTextColor: '#a1a1aa', tertiaryBorderColor: '#2a2a30',
    lineColor: '#6b6b75', textColor: '#c9c9cd',
    mainBkg: '#1d1d21', nodeBorder: '#3a3a42', nodeTextColor: '#f2f2f0',
    clusterBkg: 'rgba(57,135,229,.055)', clusterBorder: '#2a4a72',
    edgeLabelBackground: '#0c0c0e', titleColor: '#f2f2f0'
  };
  var LIGHT = {
    background: 'transparent',
    primaryColor: '#ffffff', primaryTextColor: '#0b0b0b', primaryBorderColor: '#c9c8c1',
    secondaryColor: '#eef4fc', secondaryTextColor: '#0b0b0b', secondaryBorderColor: '#a9c8ec',
    tertiaryColor: '#f4f4f2', tertiaryTextColor: '#52514e', tertiaryBorderColor: '#e2e1dc',
    lineColor: '#8a8984', textColor: '#33322f',
    mainBkg: '#ffffff', nodeBorder: '#c9c8c1', nodeTextColor: '#0b0b0b',
    clusterBkg: 'rgba(42,120,214,.05)', clusterBorder: '#a9c8ec',
    edgeLabelBackground: '#fafaf9', titleColor: '#0b0b0b'
  };

  // 原始源码存起来，切主题时要用它重绘
  var nodes = Array.prototype.slice.call(document.querySelectorAll('.mermaid'));
  nodes.forEach(function (n) { n.dataset.src = n.textContent; });

  function conf() {
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    return {
      startOnLoad: false, securityLevel: 'loose', theme: 'base',
      fontFamily: FONT, fontSize: 13,
      flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true,
                   padding: 11, nodeSpacing: 34, rankSpacing: 40, diagramPadding: 8 },
      themeVariables: dark ? DARK : LIGHT
    };
  }

  function draw() {
    nodes.forEach(function (n) {
      n.removeAttribute('data-processed');
      n.innerHTML = n.dataset.src;
    });
    mermaid.initialize(conf());
    mermaid.run({ nodes: nodes }).catch(function (e) { console.warn('mermaid:', e); });
  }

  draw();
  window.addEventListener('ads-theme-change', draw);
})();
</script>
"""


def shell(*, title: str, crumb: str, nav: str, main: str, toc: str, is_index: bool,
          mermaid: bool = False) -> str:
    prefix = "" if is_index else ""
    mermaid_block = MERMAID_JS if mermaid else ""
    return f"""<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · {BRAND} docs</title>
<link rel="stylesheet" href="{prefix}assets/docs.css">
<script>
  // 主题在样式生效前确定，避免闪白
  (function () {{
    try {{
      var t = localStorage.getItem('ads-docs-theme');
      if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', t);
    }} catch (e) {{}}
  }})();
</script>
</head>
<body>

<header class="topbar">
  <button class="icon-btn" id="navToggle" aria-label="切换导航" aria-expanded="false">{SVG_MENU}</button>
  <a class="brand" href="index.html"><span class="dot"></span>{BRAND}</a>
  <span class="sep">/</span>
  <span class="crumb">{html.escape(crumb)}</span>
  <span class="spacer"></span>
  <button class="icon-btn" id="themeToggle" aria-label="切换深浅色">{SVG_SUN}{SVG_MOON}</button>
</header>

<div class="layout">
  <nav class="sidebar" id="sidebar">{nav}</nav>
  <main class="content">{main}</main>
  {toc}
</div>

<script>
(function () {{
  var root = document.documentElement;

  document.getElementById('themeToggle').addEventListener('click', function () {{
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try {{ localStorage.setItem('ads-docs-theme', next); }} catch (e) {{}}
    window.dispatchEvent(new Event('ads-theme-change'));   // 通知 Mermaid 重绘
  }});

  var toggle = document.getElementById('navToggle');
  var sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {{
    toggle.addEventListener('click', function () {{
      var open = sidebar.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    }});
    document.addEventListener('click', function (e) {{
      if (window.innerWidth > 900) return;
      if (!sidebar.contains(e.target) && !toggle.contains(e.target)) sidebar.classList.remove('open');
    }});
  }}

  // 目录高亮：跟随阅读位置
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (links.length) {{
    var map = {{}};
    var targets = [];
    links.forEach(function (a) {{
      var el = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
      if (el) {{ map[el.id] = a; targets.push(el); }}
    }});
    var io = new IntersectionObserver(function (entries) {{
      entries.forEach(function (en) {{
        if (!en.isIntersecting) return;
        links.forEach(function (l) {{ l.classList.remove('active'); }});
        var a = map[en.target.id];
        if (a) a.classList.add('active');
      }});
    }}, {{ rootMargin: '-76px 0px -72% 0px', threshold: 0 }});
    targets.forEach(function (t) {{ io.observe(t); }});
  }}
}})();
</script>
{mermaid_block}
</body>
</html>
"""


def build_toc(doc: Doc) -> str:
    if not doc.toc:
        return '<aside class="toc"></aside>'
    items = "\n".join(
        f'<a class="lvl-{lvl}" href="#{hid}">{html.escape(text)}</a>'
        for lvl, hid, text in doc.toc
    )
    return f'<aside class="toc"><div class="label">本页目录</div>{items}</aside>'


def build_pager(docs: list[Doc], i: int) -> str:
    prev_d = docs[i - 1] if i > 0 else None
    next_d = docs[i + 1] if i < len(docs) - 1 else None
    p = (f'<a href="{prev_d.href}"><div class="dir">← 上一篇</div>'
         f'<div class="name">{html.escape(prev_d.num + " · " + prev_d.title)}</div></a>'
         if prev_d else '<span class="none"></span>')
    n = (f'<a class="next" href="{next_d.href}"><div class="dir">下一篇 →</div>'
         f'<div class="name">{html.escape(next_d.num + " · " + next_d.title)}</div></a>'
         if next_d else '<span class="none"></span>')
    return f'<nav class="pager">{p}{n}</nav>'


# ---------------------------------------------------------------- 主流程

def main() -> int:
    if not SRC_DIR.exists():
        print(f"源目录不存在: {SRC_DIR}", file=sys.stderr)
        return 1

    docs = [Doc(p) for p in sorted(SRC_DIR.glob("*.md"))]
    if not docs:
        print(f"{SRC_DIR} 下没有 .md", file=sys.stderr)
        return 1
    by_num = {d.num: d for d in docs}

    for d in docs:
        render(d, by_num)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 各篇文档
    for i, d in enumerate(docs):
        main_html = (
            '<div class="doc-head">'
            f'<div class="eyebrow">文档 {d.num}</div>'
            f"<h1>{html.escape(d.title)}</h1>"
            "</div>"
            f"{d.html}"
            f"{build_pager(docs, i)}"
        )
        page = shell(
            title=f"{d.num} · {d.title}",
            crumb=f"{d.num} · {d.title}",
            nav=nav_html(by_num, d.num),
            main=main_html,
            toc=build_toc(d),
            is_index=False,
            mermaid=d.has_mermaid,
        )
        (OUT_DIR / d.href).write_text(page, encoding="utf-8")
        print(f"  ✓ {d.href}")

    # 索引页
    cards = []
    for label, nums in GROUPS:
        cards.append(f'<div class="section-head">{label}</div><div class="card-grid">')
        for n in nums:
            d = by_num.get(n)
            if not d:
                continue
            cards.append(
                f'<a class="card" href="{d.href}">'
                f'<div class="num">{d.num}</div>'
                f'<div class="title">{html.escape(d.title)}</div>'
                f'<div class="desc">{html.escape(BLURBS.get(n, ""))}</div></a>'
            )
        cards.append("</div>")

    index_main = (
        '<div class="hero">'
        '<div class="eyebrow">Design Docs</div>'
        "<h1>ai-drama-studio 设计文档</h1>"
        "<p>本地优先的 AI 短剧生产系统：输入一个故事，输出可播放的分集短剧成片。"
        "以下文档按设计域划分，每篇回答一个独立的设计问题，可单独阅读。</p>"
        "</div>"
        + "".join(cards)
        + '<div class="section-head">另见</div>'
        '<div class="card-grid">'
        '<a class="card" href="../README.md"><div class="num">README</div>'
        '<div class="title">项目说明</div><div class="desc">技术选型速览、快速开始、里程碑概览</div></a>'
        '<a class="card" href="adr/"><div class="num">ADR</div>'
        '<div class="title">架构决策记录</div><div class="desc">十条关键决策的背景、备选与后果</div></a>'
        "</div>"
    )

    (OUT_DIR / "index.html").write_text(
        shell(title="设计文档", crumb="设计文档", nav=nav_html(by_num, None),
              main=index_main, toc='<aside class="toc"></aside>', is_index=True),
        encoding="utf-8",
    )
    print("  ✓ index.html")
    print(f"\n完成：{len(docs) + 1} 个页面 → {OUT_DIR}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
