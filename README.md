# EngBlog Reader · 英文技术博客阅读助手

本地全栈英文技术博客阅读器：粘贴 Markdown → 还原排版阅读 → 划词实时翻译（LLM 流式）→ TTS 朗读 → 划线笔记 → 阅读历史管理。

## 功能

| 功能 | 说明 |
|---|---|
| 📄 Markdown 导入 | 粘贴文本 / 拖入 `.md` 文件 / **粘贴原文链接自动抓取网页正文**，自动识别标题，GitHub 风格渲染 + 代码高亮 |
| 🌐 实时翻译 | 划词 →「翻译」；悬浮段落 →「译」；流式输出，可选「流畅直译 / 直译+术语解释」 |
| 🔊 TTS 朗读 | 双引擎：**Edge 神经语音**（高质量美音男/女声，跨平台一致，需联网）/ 浏览器内置（离线）；支持划词朗读、段落朗读、全文连读（段落级高亮跟随）、语速调节、音色试听 |
| 🖍 划线笔记 | 划词高亮、写笔记；点击划线查看/编辑/删除；笔记侧边栏点击跳转 |
| 📚 历史管理 | 文章入库、阅读进度自动保存（继续阅读）、搜索、删除、导出 `.md` |

## 快速开始

```bash
./run.sh                # 自动建 venv 并安装依赖
# 或手动： python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
#         .venv/bin/python server/main.py
```

浏览器打开 http://127.0.0.1:8000

## 配置 LLM 翻译

页面右上角 ⚙ 设置里填写：

- **Base URL**：任何 OpenAI 兼容端点
  - DeepSeek：`https://api.deepseek.com/v1`
  - OpenAI：`https://api.openai.com/v1`
  - 本地 Ollama：`http://localhost:11434/v1`（Key 留空即可）
  - 本地 vLLM / 微调模型：`http://localhost:8000/v1`
- **API Key**：密钥保存在本地 `data/config.json`（或通过环境变量 `LLM_API_KEY` 注入）
- **模型名**：如 `deepseek-chat`、`gpt-4o-mini`、`qwen2.5:7b`

支持环境变量：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（优先级高于配置文件）。

### 接入微调的小模型

本工具走标准 OpenAI 兼容协议。把微调好的模型用 [vLLM](https://docs.vllm.ai) 或 `ollama serve` 起一个兼容端点，然后在设置里填 Base URL + 模型名即可无缝替换，无需改代码。

### 翻译风格

`流畅直译`：仅输出译文；`直译 + 术语解释`：译文后附关键术语与技术背景讲解，适合学习场景。

## 数据存储与备份

| 数据 | 位置 |
|---|---|
| 配置（LLM key 等） | `data/config.json` |
| 文章 / 划线笔记 / 阅读进度 | `data/blog.db`（SQLite，本地落盘） |

- **存储目录可配置**：设置环境变量 `DATA_DIR=/你的/路径` 再启动，即可把数据放到任意位置（如 Docker 挂载卷、外置盘）
- **启动自动备份**：数据有变化时每次启动自动备份到 `data/backup/blog-日期.db`（保留最近 20 份）
- **手动备份/迁移**：设置 ⚙ →「数据管理」→ 导出全部数据（JSON，含划线笔记）／从备份恢复
- 划线笔记以**文本字符偏移量**持久化（非 DOM），Markdown 不变则重新渲染后位置依然精确

> 常见误区：数据存在服务端 SQLite，不是浏览器 localStorage；只要 `data/` 目录不被删除，重启服务/电脑数据都在。

## 手机阅读（H5 / PWA）

应用本身就是 Web 应用，手机浏览器直接访问即可，无需单独做 App：

- **手机访问**：服务已监听 `0.0.0.0`，同一 Wi-Fi 下手机浏览器打开 `http://<服务器IP>:8000` 即可（设置 → 数据管理可确认）
- **触屏适配**：长按划词 → 翻译/整段/朗读/高亮/笔记；浮层按钮加大触控目标；代码块横向滚动；刘海屏安全区适配
- **添加到主屏幕（PWA）**：手机浏览器「添加到主屏幕」后可全屏像 App 一样用；支持离线打开（Service Worker 缓存应用外壳）
  - ⚠️ Service Worker 需要 HTTPS 或 localhost 才生效，纯 `http://局域网IP` 访问时自动跳过（不影响使用）
- **手机端段落翻译**：触屏没有 hover，选中任意词后点「整段」即可翻译整段

## 项目结构

```
engblog-reader/
├── run.sh               # 一键启动
├── server/
│   ├── main.py          # FastAPI：API + 静态资源
│   ├── database.py      # SQLite（文章、划线、进度）
│   ├── llm.py           # LLM 流式翻译代理（OpenAI 兼容）
│   ├── config.py        # 配置读写（支持环境变量覆盖）
│   └── requirements.txt
├── static/
│   ├── index.html
│   ├── css/style.css    # 明暗双主题
│   └── js/app.js        # 前端全部逻辑（原生 JS，无构建）
└── data/                # 运行时自动创建
```

## API 一览

```
GET    /api/articles                文章列表（含进度）
POST   /api/articles                导入文章（自动识别标题）
POST   /api/fetch                  抓取 URL 网页正文 → Markdown
GET    /api/articles/{id}           文章 + 划线
PUT    /api/articles/{id}           更新
PUT    /api/articles/{id}/progress  保存阅读进度
DELETE /api/articles/{id}           删除（级联删划线）
POST   /api/articles/{id}/highlights  添加划线
PUT    /api/highlights/{id}         更新笔记
DELETE /api/highlights/{id}         删除划线
POST   /api/translate               流式翻译（SSE）
POST   /api/tts                     Edge 语音合成（MP3）
POST   /api/llm/test                连接测试
GET/PUT /api/config                 读写配置
GET    /api/export                  导出全部数据（JSON 备份）
POST   /api/import                  从备份恢复
```

## 技术说明 / 后续可扩展

- 翻译走服务端代理，API Key 不暴露给浏览器。
- URL 抓取用 [trafilatura](https://trafilatura.readthedocs.io) 提取正文（支持多数静态/SSR 博客；JS 动态渲染站点如部分 SPA 会失败，需手动粘贴）。
- TTS：默认 Edge 神经语音（`edge-tts`，美音男声如 Christopher/Guy/Andrew），需联网访问微软服务；离线可切回浏览器内置引擎。设置中可试听、标注性别。
- 前端零构建（原生 JS + markdown-it + highlight.js CDN），离线使用时可将两个 CDN 库下载到 `static/vendor/` 并替换 `<script>` 标签。
- 后续可扩展：翻译缓存（避免重复计费）、双语对照模式、RSS 订阅导入、edge-tts 高质量朗读。
