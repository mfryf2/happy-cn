<div align="center">
  <img src="/.github/logotype-dark.png" width="400" title="Happy Coder" alt="Happy Coder"/>
</div>

<h1 align="center">Happy Coder — 中国大陆远程控制方案</h1>

<h4 align="center">
  在手机或浏览器上远程控制你的 Claude Code，完全运行在国内，无需翻墙
</h4>

<div align="center">

[🌐 **Web App 体验地址**](https://happy.mingbaibao.com) · [📖 **English README**](./README.md) · [💬 **提 Issue**](https://github.com/mfryf2/happy-cn/issues)

</div>

---

## 为什么需要这个方案？

Anthropic 官方推出了 [Remote Control](https://code.claude.com/docs/zh-CN/remote-control) 功能，但对中国大陆用户**完全不可用**：

| 限制 | 说明 |
|---|---|
| 需要 `claude.ai` 账号 | 国内无法注册和访问 |
| 消息路由走 `api.anthropic.com` | 国内被封 |
| 不支持中转 API | 官方明确不支持第三方 API 提供商 |
| 不支持定制版 Claude Code | 如各公司内部封装的定制版本 |

本方案基于开源项目 [slopus/happy](https://github.com/slopus/happy)，针对中国大陆环境做了适配，**完全运行在国内服务器，支持所有 Claude Code 变种**。

---

## 支持的场景

### 场景一：中转 API 用户
使用第三方中转 API（如 [api.gptsapi.com](https://api.gptsapi.com)、[burn.hair](https://burn.hair) 等）运行标准 `claude` 命令的用户。

→ [快速开始 — 场景一](#场景一中转-api-用户-1)

### 场景二：公司定制版 Claude Code
使用公司内部封装的定制版 Claude Code（带 `#!/usr/bin/env node` shebang 的可执行脚本）的用户。

→ [快速开始 — 场景二](#场景二公司定制版-claude-code-1)

### 场景三：自建服务器（进阶）
不想使用公共服务器，或需要为团队提供独立服务的用户。

→ [快速开始 — 场景三](#场景三自建服务器进阶)

---

## 前置条件（所有场景通用）

1. **Mac/Linux 本地环境**，已能正常运行 `claude`（或你的定制版本）
2. **Node.js 18+**，推荐通过 nvm 安装
3. **克隆本仓库并编译**：

```bash
git clone https://github.com/mfryf2/happy-cn.git
cd happy-cn
yarn install
yarn workspace happy build
```

4. **在 `~/.zshrc`（或 `~/.bashrc`）中添加 alias**：

```bash
# 替换为你的实际路径
alias happy="node /path/to/happy-cn/packages/happy-cli/dist/index.mjs"
```

```bash
source ~/.zshrc
```

---

## 场景一：中转 API 用户

### 适用人群
- 使用 `ANTHROPIC_BASE_URL` 指向国内中转服务
- 本地能正常运行标准 `claude` 命令

### 配置步骤

**第一步：配置环境变量**

在 `~/.zshrc` 中添加（使用公共服务器，无需自建）：

```bash
export HAPPY_SERVER_URL="https://happy.mingbaibao.com"
export HAPPY_WEBAPP_URL="https://happy.mingbaibao.com"
alias happy="node /path/to/happy-cn/packages/happy-cli/dist/index.mjs"
```

> `HAPPY_CLAUDE_PATH` 不需要设置，happy 会自动找到系统中的 `claude` 命令。

```bash
source ~/.zshrc
```

**第二步：在浏览器中注册账号**

打开 [https://happy.mingbaibao.com](https://happy.mingbaibao.com)，点击「**Create account**」注册账号。

> 账号密钥完全存储在你的浏览器本地，服务器只保存加密后的内容，无法看到你的代码和对话。

**第三步：绑定终端**

```bash
happy auth login
```

终端会自动打开浏览器，在页面上点「**接受连接**」完成绑定。

**第四步：开始使用**

```bash
happy
```

浏览器或手机打开 `https://happy.mingbaibao.com` 即可实时查看和控制你的 Claude 会话。

---

## 场景二：公司定制版 Claude Code

### 适用人群
- 使用公司内部封装的定制版 Claude Code
- 可执行文件带有 `#!/usr/bin/env node` shebang

### 与场景一的区别

官方 happy 使用 `import()` 加载 Claude，但公司定制版通常是**独立可执行脚本**，必须用 `spawn` 方式启动。本仓库已包含此修复（`claude_version_utils.cjs` 中的 shebang 检测），无需手动修改代码。

### 配置步骤

**第一步：找到你的定制版路径**

```bash
which your-claude-command   # 替换为你公司定制版的命令名
# 例如：/opt/homebrew/bin/your-claude-command
```

**第二步：配置环境变量**

```bash
# 在 ~/.zshrc 中添加
export HAPPY_CLAUDE_PATH="/opt/homebrew/bin/your-claude-command"  # 改为你的实际路径
export HAPPY_SERVER_URL="https://happy.mingbaibao.com"
export HAPPY_WEBAPP_URL="https://happy.mingbaibao.com"
alias happy="node /path/to/happy-cn/packages/happy-cli/dist/index.mjs"
```

```bash
source ~/.zshrc
```

**第三步：验证配置**

```bash
happy --version
# 应该显示：Using Claude Code vX.X.X from HAPPY_CLAUDE_PATH
```

**第四步：注册账号 + 绑定终端**（同场景一第二、三步）

```bash
# 浏览器打开 https://happy.mingbaibao.com 注册账号，然后：
happy auth login
```

**第五步：开始使用**

```bash
happy   # 启动你的定制版 Claude Code，支持远程控制
```

### 注意事项

- `happy` 命令完全替代你原来的定制版命令，所有参数透传
- 原来的定制版命令**不受影响**，两者互不干扰
- 若定制版禁用了 `codex app-server` 子命令，则 `happy codex` 不可用

---

## 场景三：自建服务器（进阶）

### 适用人群
- 不想使用公共服务器
- 需要为团队提供独立部署
- 有自己的国内服务器和域名

### 前置要求

- 国内云服务器（1 核 2G 内存起，推荐 2 核 4G）
- 已备案的域名（HTTPS 必须，浏览器安全策略要求）
- 服务器开放 80、443 端口

### 详细部署步骤

请参阅 **[SELF_HOSTED_GUIDE.md](./SELF_HOSTED_GUIDE.md)**，包含：

- 服务器环境安装（Node.js 20）
- happy-server 部署（standalone 模式，内嵌数据库）
- Web App 构建与部署
- nginx + Let's Encrypt HTTPS 配置
- systemd 开机自启
- 更新维护指南

---

## 功能对比

| 功能 | 官方 Remote Control | 本方案 |
|---|---|---|
| 浏览器远程控制 | ✅ | ✅ |
| 手机远程控制 | ✅ (App) | ✅ (PWA 网页) |
| 国内可用 | ❌ | ✅ |
| 支持中转 API | ❌ | ✅ |
| 支持定制版 Claude Code | ❌ | ✅ |
| 推送通知 | ✅ | ❌ (浏览器版无推送) |
| 端到端加密 | ✅ | ✅ |
| 开源 | ✅ | ✅ |

---

## 一键更新

### 本地更新（同步官方代码 + 重新编译 CLI）

```bash
bash scripts/update-local.sh
```

自动完成：拉取官方最新代码 → 合并 → 重新编译 → 推送到你的 fork。

### 服务端更新（更新服务器上的后端和 Web App）

**第一步：配置服务器信息（只需一次）**

```bash
export HAPPY_SERVER_HOST="你的服务器IP"
export HAPPY_DOMAIN="your-domain.com"
export HAPPY_SSH_KEY="~/.ssh/id_ed25519"  # 可选，默认值
```

或者直接写入 `~/.zshrc` 永久保存。

**第二步：一键更新**

```bash
# 更新后端 + 前端（全量）
bash scripts/update-server.sh

# 只更新后端服务
bash scripts/update-server.sh --server-only

# 只更新前端 Web App
bash scripts/update-server.sh --webapp-only
```

### 完整更新流程（官方有新版本时）

```bash
# 第一步：更新本地
bash scripts/update-local.sh

# 第二步：更新服务器
bash scripts/update-server.sh
```

---

## 与上游的差异

本仓库基于 [slopus/happy](https://github.com/slopus/happy)，仅做了以下改动：

| 文件 | 改动内容 |
|---|---|
| `packages/happy-cli/scripts/claude_version_utils.cjs` | 增加 shebang 检测，支持定制版 Claude Code（带 `#!/usr/bin/env node` 的独立脚本） |
| `README.zh.md` | 新增（本文件） |
| `SELF_HOSTED_GUIDE.md` | 新增中国大陆自建服务器完整指南 |

与上游完全向后兼容，可随时 `git merge upstream/main` 同步官方更新。

---

## 常见问题

**Q：公共服务器安全吗？会不会看到我的代码？**

所有代码内容在发送前由客户端加密（AES-256-GCM），服务器只存储密文，无法解密。参考 [加密说明](./docs/encryption.md)。

**Q：支持 Windows 吗？**

happy 支持 Windows，但 shebang 检测修复仅针对 macOS/Linux。Windows 上的定制版需要额外适配。

**Q：公共服务器会一直维护吗？**

公共服务器 `happy.mingbaibao.com` 由本仓库维护者提供，不保证永久可用。建议有条件的团队参考场景三自行部署。

**Q：如何同步官方更新？**

```bash
git remote add upstream https://github.com/slopus/happy.git
git fetch upstream
git merge upstream/main
yarn workspace happy build
```

---

## License

MIT — 基于 [slopus/happy](https://github.com/slopus/happy)
