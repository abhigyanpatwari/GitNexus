# superpowers-sdd 插件安装手册

> **用途**：本手册供 Claude / LLM 阅读，LLM 按步骤引导人类用户完成安装。
> **核心原则**：每一步先检查是否已满足，已满足则跳过，绝不重复安装。

---

## 概述

**superpowers-sdd** 是 CRM4 团队的 SDD（Structured Development Discipline）工作流引擎，构建于 `superpowers` 插件之上，提供从提案、调试、保存、归档到知识编译的完整结构化开发流程。

### 依赖链

```
① superpowers 插件（官方市场）
     ↓ 必需
② crm4-cc-plugins 市场注册（本地团队市场）
     ↓ 必需
③ superpowers-sdd 插件（团队市场）
     ↓ 可选
④ Inkscape / pandoc / agent-browser / Python olefile
```

**预估耗时**：必需步骤约 5 分钟，含全部可选依赖约 15 分钟。

---

## 0. 环境前提

在开始之前，确认以下环境已就绪。每一项缺失都需要 👤 **人类手动安装**。

| 检查项 | 验证命令 | 最低版本 |
|--------|---------|---------|
| Claude Code | `claude --version` | 任意正式版 |
| Node.js | `node --version` | 18+ |
| Python | `python --version` | 3.8+ |
| Git | `git --version` | 任意正式版 |

**执行方式**：用 Bash 工具逐条运行验证命令。全部通过后进入 Step 1。若有缺失，提示人类安装对应软件后重试。

---

## 1. 安装 superpowers 插件（必需）

superpowers 是第三方插件，提供 brainstorming / systematic-debugging / writing-plans 等核心技能，superpowers-sdd 强依赖它。

### 1.1 检查

在 Claude Code 中运行：

```
/plugin
```

在已安装列表中查找 `superpowers`。若已存在，跳到 [Step 2](#2-注册-crm4-cc-plugins-市场必需)。

### 1.2 安装

在 Claude Code 中运行：

```
/plugin install superpowers@claude-plugins-official
```

👤 **若安装失败**：可能是网络问题，提示人类开启 VPN 后重试。

### 1.3 验证

再次运行 `/plugin`，确认列表中出现 `superpowers`。

---

## 2. 注册 crm4-cc-plugins 市场（必需）

crm4-cc-plugins 是 CRM4 团队的本地插件市场，superpowers-sdd 从该市场安装。

### 2.1 检查

读取文件 `~/.claude/plugins/known_marketplaces.json`，查找是否包含 `crm4-cc-plugins` 条目。若已存在，跳到 [Step 3](#3-安装-superpowers-sdd-插件必需)。

### 2.2 前置条件

确保本地已 clone crm4-cc-plugins 仓库。若未 clone：

👤 **提示人类执行**：
```bash
git clone https://git-nj.iwhalecloud.com/cvbsv8/crm4-cc-plugins.git
```

### 2.3 注册

👤 **提示人类在终端执行**（需要替换为实际 clone 路径）：

```bash
claude plugin marketplace add <crm4-cc-plugins 仓库的本地路径>
```

例如：`claude plugin marketplace add D:\IdeaProjects\crm4-cc-plugins`

### 2.4 验证

读取 `~/.claude/plugins/known_marketplaces.json`，确认包含 `crm4-cc-plugins` 条目。

---

## 3. 安装 superpowers-sdd 插件（必需）

### 3.1 检查

在 Claude Code 中运行 `/plugin`，查找已安装列表中是否有 `superpowers-sdd`。若已存在，跳到 [3.4 初始化](#34-初始化)。

### 3.2 安装

在 Claude Code 中运行：

```
/plugin install superpowers-sdd@crm4-cc-plugins
```

### 3.3 验证

运行 `/plugin`，确认列表中出现 `superpowers-sdd`。

### 3.4 初始化

首次安装后，需要配置用户信息。在 Claude Code 中运行：

```
/superpowers-sdd:init
```

👤 **该命令会要求输入姓名和工号**，LLM 通过 AskUserQuestion 收集后写入配置。

初始化完成后，`.claude/settings.local.json` 中的 `env` 应包含 `USER_NAME` 和 `USER_ID`。

---

## 4. 安装 Inkscape（可选 — EMF 转 SVG）

**用途**：`crawl-task-doc` 爬取的任务单附件中可能包含 EMF（Windows Metafile）图片，需用 Inkscape 转为 SVG。

### 4.1 检查

```bash
inkscape --version
```

若返回版本号（如 `Inkscape 1.3`），跳到 [Step 5](#5-安装-pandoc可选--docxpptx-转-markdown)。

### 4.2 安装

👤 **提示人类在终端执行**：

```powershell
winget install Inkscape.Inkscape
```

或从 https://inkscape.org 下载安装。

### 4.3 验证

重新打开终端后运行 `inkscape --version`。

---

## 5. 安装 pandoc（可选 — docx/pptx 转 Markdown）

**用途**：`crawl-task-doc` 将任务单附件中的 docx/pptx 文件转换为可阅读的 Markdown。

### 5.1 检查

```bash
pandoc --version
```

若返回版本号（如 `pandoc 3.1`），跳到 [Step 6](#6-安装-agent-browser可选--爬取云雀任务单)。

### 5.2 安装

👤 **提示人类在终端执行**：

```powershell
winget install JohnMacFarlane.Pandoc
```

### 5.3 验证

重新打开终端后运行 `pandoc --version`。

---

## 6. 安装 agent-browser（可选 — 爬取云雀任务单）

**用途**：`crawl-task-doc` 通过 agent-browser 爬取云雀研发云（`dev.iwhalecloud.com`）的任务单页面。

### 6.1 检查

```bash
agent-browser --version
```

若返回版本号，跳到 [Step 7](#7-配置-agent-browser-认证可选--依赖-step-6)。

### 6.2 安装

👤 **提示人类在终端执行**：

```bash
npm install -g @anthropic-ai/agent-browser
```

若 npm 不可用，参考 [agent-browser 官方文档](https://github.com/anthropics/agent-browser)。

### 6.3 验证

运行 `agent-browser --version`。

---

## 7. 配置 agent-browser 认证（可选 — 依赖 Step 6）

> ⚠️ 此步骤仅当需要使用 `/superpowers-sdd:propose` 爬取云雀任务单时才需要。

需要配置两个认证 session，分别用于两个不同域名。

### 7.1 配置 iwhale 开发平台认证

👤 **提示人类在终端执行**：

```bash
agent-browser auth save iwhale --url https://dev.iwhalecloud.com --username <工号>
```

系统会提示输入密码。

验证：
```bash
agent-browser auth list
```

确认列表中有 `iwhale`。

### 7.2 配置云雀文档认证

👤 **提示人类在终端执行**：

```bash
echo '<密码>' | agent-browser auth save yunque-docs --url https://docs.iwhalecloud.com --username <工号> --password-stdin --submit-selector ".loginBtn"
```

> **注意**：云雀文档的登录按钮是 `<div class="loginBtn">`，不是标准表单按钮，必须通过 `--submit-selector ".loginBtn"` 指定。

验证：
```bash
agent-browser auth list
```

确认列表中同时有 `iwhale` 和 `yunque-docs`。

> ⚠️ **云雀文档使用飞连动态令牌 OTP**，认证可能不稳定。若 `auth login` 失败，可使用 session 模式：`agent-browser --session-name yunque-docs open https://docs.iwhalecloud.com`，手动登录后 session 会持久化。

---

## 8. 安装 Python olefile（可选 — docx OLE 提取）

**用途**：`crawl-task-doc` 从 docx 附件中提取嵌入的 OLE 对象（如 JSON 文件、文本文件等）。

### 8.1 检查

```bash
python -c "import olefile; print(olefile.__version__)"
```

若返回版本号，跳到 [最终验证](#9-安装完成验证清单)。

### 8.2 安装

```bash
pip install olefile
```

### 8.3 验证

```bash
python -c "import olefile; print(olefile.__version__)"
```

---

## 9. 安装完成验证清单

全部安装完成后，LLM 执行以下命令一次性验证所有组件：

| 验证项 | 命令 | 预期结果 |
|--------|------|---------|
| superpowers 插件 | `/plugin` | 已安装列表含 `superpowers` |
| superpowers-sdd 插件 | `/plugin` | 已安装列表含 `superpowers-sdd` |
| 用户初始化 | 读取 `.claude/settings.local.json` | `env` 含 `USER_NAME` 和 `USER_ID` |
| Inkscape（可选） | `inkscape --version` | 返回版本号 |
| pandoc（可选） | `pandoc --version` | 返回版本号 |
| agent-browser（可选） | `agent-browser --version` | 返回版本号 |
| agent-browser 认证（可选） | `agent-browser auth list` | 含 `iwhale` + `yunque-docs` |
| Python olefile（可选） | `python -c "import olefile"` | 无报错 |

全部 ✅ 即可开始使用。第一个任务试试 `/superpowers-sdd:propose` 吧！

---

## 常见问题

### Q: `/plugin install superpowers` 失败？

检查网络连通性。superpowers 托管在 GitHub，需要 VPN 或代理。👤 提示人类开启 Clash 后重试。

### Q: `claude plugin marketplace add` 报错？

确保已将 crm4-cc-plugins 仓库 clone 到本地，路径正确。路径中不要有中文或空格。

### Q: agent-browser auth login 失败（`navigation destroyed`）？

云雀文档页面跳转时 Playwright navigation promise 可能被 reject。改用 session 模式绕过：
```bash
agent-browser --session-name yunque-docs open https://docs.iwhalecloud.com
```
👤 手动登录一次，后续 session cookie 会自动复用。

### Q: Inkscape / pandoc 安装后命令找不到？

Windows 安装后需要重新打开终端（刷新 PATH）。若仍找不到，检查是否已加入系统 PATH。
