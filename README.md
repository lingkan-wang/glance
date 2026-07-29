# Glance 一瞥

选中一段英文，中文译文就浮在原文上方。为读论文而做，所以 PDF 是一等公民。

![icon](icons/icon128.png)

## 装上它

1. Chrome 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `~/glance` 这个文件夹
4. 想读本地 PDF 的话，在扩展详情里再打开「允许访问文件网址」

不需要填任何 Key 就能用：默认走 Google 的免费翻译接口。

## 它怎么工作

**网页**：内容脚本在每个页面里挂一个 closed shadow root，鼠标松开时读选区，
浮层从选区位置缩放展开（180ms，`cubic-bezier(0.23,1,0.32,1)`），页面滚动时用
`transform` 跟随选区，选区滚出视口就自动收起。

**PDF**：Chrome 自带的 PDF 阅读器是独立插件，扩展读不到里面的选区。所以 Glance
自带一个 pdf.js 阅读器，`.pdf` 链接（以及 arXiv 那种没有扩展名的）会用
declarativeNetRequest 重定向过去。真正的文本层意味着选区、复制、查找都照常工作。
这层可以在设置里关掉。

**排版清理**：PDF 的选区会带着硬换行和连字符断词（`technology-\nsupported`）。
直接丢给翻译器会出乱码般的结果，所以 `normalize()` 先补断词、合并换行、还原
连字（ﬁ ﬂ）和弯引号，再发出去。这是 PDF 翻译质量的分水岭。

## 引擎

| 引擎 | 需要 Key | 说明 |
| --- | --- | --- |
| Google | 否 | 默认。快、够用、无需配置 |
| DeepL | 是 | 长句更自然 |
| OpenAI 兼容 | 是 | 流式输出，可填任意兼容 base URL |
| Claude | 是 | 流式输出，默认 `claude-opus-5`，术语最稳 |

LLM 引擎带一段学术翻译的 system prompt：保留公认英文术语与缩写、数字、公式和
引用标记，只输出译文。请求关掉了思考（翻译不需要），并且新选区一来就 abort 掉
上一条请求。命中过的选区走内存 LRU 缓存，重复划词是瞬时的。

Key 存在 `chrome.storage.local`，只发往你选的服务商。

## 快捷操作

- `Esc` 收起浮层
- 阅读器里 `←/→` 或 `J/K` 翻页，`⌘+` / `⌘-` 缩放，`⌘0` 适应宽度
- 点百分比也是适应宽度
- 右键选中文本 →「用 Glance 翻译」
- 点工具栏图标弹出面板：总开关、本页是否已生效、打开阅读器、设置

## 目录

```
manifest.json
src/
  background.js       引擎、LRU 缓存、PDF 重定向规则、装完注入已开标签页
  popup/              工具栏面板（开关 + 本页状态检测）
  lens/lens.js        划词浮层（内容脚本 + 阅读器共用一份）
  viewer/             pdf.js 阅读器
  options/            设置页
vendor/               pdf.js 6.2.108（Apache-2.0）+ 抽出来的 textLayer 样式
dev/index.html        本地调试页，没有扩展环境时直接走 Google 接口
```

本地调试：`python3 -m http.server 4820 --directory ~/glance`，然后开
`http://localhost:4820/dev/index.html`（划词浮层）或
`http://localhost:4820/src/viewer/viewer.html?file=/dev/sample.pdf`（阅读器）。

## 已知边界

- Google 免费接口没有 SLA，划得太频繁可能被限流；此时换 DeepL 或 LLM 引擎。
- 跨源 PDF 用扩展的 host 权限直取；需要登录墙后面的文件时靠站点 cookie，个别站点
  仍可能拒绝。
- 扫描版 PDF 没有文本层，选不中也就翻不了。
