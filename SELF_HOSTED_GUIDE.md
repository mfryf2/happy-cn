# 场景三：自建服务器完整指南

> 本文档是 [README.zh.md](./README.zh.md) 场景三的详细展开。
> 适合有服务器资源、希望为团队提供独立部署的用户。
>
> 基于 [happy](https://github.com/slopus/happy) 开源项目，适配中国大陆环境

---

## 一、整体架构

```
手机/浏览器
    ↓ HTTPS
https://happy.mingbaibao.com  (nginx 反代)
    ↓ 本地
happy-server:3005  (Node.js standalone，PGlite 内嵌数据库)
    
Mac 终端
    ↓ happy 命令（本地源码编译版）
claude-internal  (腾讯内部版 Claude Code)
    ↓ WebSocket
https://happy.mingbaibao.com
```

---

## 二、服务器环境要求

- **系统**：Linux（CentOS/OpenCloudOS/Ubuntu 均可）
- **内存**：≥ 1 GB 可用（happy-server standalone 约占 300-500 MB）
- **磁盘**：≥ 2 GB
- **端口**：80、443（需在云厂商安全组开放）
- **域名**：需要一个已备案的域名，用于 HTTPS（`SharedArrayBuffer` 要求）

---

## 三、服务器部署步骤

### 3.1 安装 Node.js 20

```bash
# 安装 nvm（国内镜像）
curl -fsSL https://gitee.com/mirrors/nvm/raw/master/install.sh | bash
source ~/.bashrc  # 或 ~/.zshrc

# 用国内镜像安装 Node 20
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
nvm install 20
nvm alias default 20

# 安装 yarn
npm config set registry https://registry.npmmirror.com
npm install -g yarn
```

### 3.2 上传并安装 happy-server

```bash
# 在本地（Mac）执行，打包源码
cd /path/to/happy
tar --exclude='node_modules' --exclude='.git' \
    --exclude='packages/happy-app' \
    --exclude='packages/happy-cli' \
    --exclude='packages/happy-agent' \
    --exclude='packages/happy-app-logs' \
    --exclude='environments/data' \
    -czf /tmp/happy-server-deploy.tar.gz \
    package.json yarn.lock scripts patches packages/happy-server packages/happy-wire

tar -czf /tmp/happy-migrations.tar.gz packages/happy-server/prisma/migrations

scp /tmp/happy-server-deploy.tar.gz root@<服务器IP>:/www/wwwroot/
scp /tmp/happy-migrations.tar.gz root@<服务器IP>:/www/wwwroot/
```

```bash
# 在服务器上执行
mkdir -p /www/wwwroot/happy && cd /www/wwwroot/happy
tar -xzf /www/wwwroot/happy-server-deploy.tar.gz
tar -xzf /www/wwwroot/happy-migrations.tar.gz

# 补充 monorepo 所需的空包目录
mkdir -p packages/happy-app packages/happy-cli packages/happy-agent packages/happy-app-logs
echo '{"name":"happy-app","version":"0.0.0","private":true}' > packages/happy-app/package.json
echo '{"name":"happy","version":"0.0.0","private":true}' > packages/happy-cli/package.json
echo '{"name":"happy-agent","version":"0.0.0","private":true}' > packages/happy-agent/package.json
echo '{"name":"happy-app-logs","version":"0.0.0","private":true}' > packages/happy-app-logs/package.json
mkdir -p packages/happy-cli/scripts packages/happy-cli/tools packages/happy-app/patches

# 安装依赖（国内镜像）
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
SKIP_HAPPY_WIRE_BUILD=1 yarn install --frozen-lockfile --ignore-engines \
    --registry https://registry.npmmirror.com

# 构建
yarn workspace @slopus/happy-wire build
yarn workspace happy-server generate  # 生成 Prisma client
```

### 3.3 配置环境变量

```bash
mkdir -p /www/wwwroot/happy-data/pglite

cat > /www/wwwroot/happy/.env.prod << EOF
HANDY_MASTER_SECRET=$(openssl rand -hex 32)
PORT=3005
DATA_DIR=/www/wwwroot/happy-data
PGLITE_DIR=/www/wwwroot/happy-data/pglite
METRICS_ENABLED=false
EOF
```

### 3.4 运行数据库迁移

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
cd /www/wwwroot/happy/packages/happy-server
set -a; source /www/wwwroot/happy/.env.prod; set +a
../../node_modules/.bin/tsx sources/standalone.ts migrate
```

### 3.5 配置 systemd 开机自启

```bash
cat > /etc/systemd/system/happy-server.service << 'EOF'
[Unit]
Description=Happy Server (standalone)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/www/wwwroot/happy/packages/happy-server
EnvironmentFile=/www/wwwroot/happy/.env.prod
ExecStart=/root/.nvm/versions/node/v20.20.2/bin/node \
    /www/wwwroot/happy/node_modules/.bin/tsx \
    sources/standalone.ts serve
Restart=always
RestartSec=5
StandardOutput=append:/www/wwwroot/logs/happy-server.log
StandardError=append:/www/wwwroot/logs/happy-server.log

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /www/wwwroot/logs
systemctl daemon-reload
systemctl enable happy-server
systemctl start happy-server

# 验证
curl http://localhost:3005/health
```

---

## 四、Web App 构建与部署

### 4.1 在本地（Mac）构建 Web App

```bash
cd /path/to/happy

# 安装依赖（如未安装）
yarn install

# 构建（指向自建服务器）
EXPO_PUBLIC_HAPPY_SERVER_URL=https://your-domain.com \
APP_ENV=production \
yarn workspace happy-app expo export --platform web \
    --output-dir packages/happy-app/dist-self-hosted

# 打包上传
cd packages/happy-app
tar -czf /tmp/happy-webapp.tar.gz dist-self-hosted
scp /tmp/happy-webapp.tar.gz root@<服务器IP>:/www/wwwroot/
```

### 4.2 在服务器上部署 Web App

```bash
mkdir -p /www/wwwroot/happy-webapp
cd /www/wwwroot
tar -xzf happy-webapp.tar.gz
cp -r dist-self-hosted/* /www/wwwroot/happy-webapp/
rm -rf dist-self-hosted
```

### 4.3 安装 nginx 并配置 HTTPS

```bash
# 安装 nginx
dnf install -y nginx  # CentOS/RHEL
# 或 apt install -y nginx  # Ubuntu

# 初始配置（先用 HTTP，申请证书用）
cat > /etc/nginx/conf.d/happy-webapp.conf << 'EOF'
server {
    listen 80;
    server_name your-domain.com;
    root /www/wwwroot/happy-webapp;
    index index.html;
    location / { try_files $uri $uri.html $uri/ /index.html; }
}
EOF

systemctl enable nginx && systemctl start nginx

# 申请 Let's Encrypt 证书
dnf install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com \
    --non-interactive --agree-tos \
    --email your@email.com --redirect
```

### 4.4 配置完整 nginx（HTTPS + API 反代 + COEP 头）

```bash
cat > /etc/nginx/conf.d/happy-webapp.conf << 'EOF'
server {
    server_name your-domain.com;
    root /www/wwwroot/happy-webapp;
    index index.html;

    # 启用 SharedArrayBuffer（libsodium wasm 必需）
    add_header Cross-Origin-Opener-Policy "same-origin";
    add_header Cross-Origin-Embedder-Policy "require-corp";

    # API 反代（把 /v1/ /v2/ /v3/ 转发到 happy-server）
    location ~ ^/(v1|v2|v3)/ {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600;
    }

    # Socket.IO 反代（WebSocket）
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600;
    }

    location /health { proxy_pass http://127.0.0.1:3005; }

    location /_expo/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Resource-Policy "cross-origin";
    }
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Resource-Policy "cross-origin";
    }
    location / { try_files $uri $uri.html $uri/ /index.html; }

    gzip on;
    gzip_types text/plain text/css application/javascript application/json application/wasm;

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if ($host = your-domain.com) { return 301 https://$host$request_uri; }
    listen 80;
    server_name your-domain.com;
    return 404;
}
EOF

nginx -t && systemctl reload nginx
```

---

## 五、本地 Mac 客户端配置

### 5.1 修改 claude_version_utils.cjs（支持 shebang JS 可执行文件）

在 `packages/happy-cli/scripts/claude_version_utils.cjs` 中，修改 `runClaudeCli` 函数，
检测 shebang，对 `claude-internal` 等 shebang 脚本用 `spawn` 而非 `import()`：

```js
function runClaudeCli(cliPath) {
    const { pathToFileURL } = require('url');
    const { spawn } = require('child_process');
    const fs = require('fs');

    const isJsFile = cliPath.endsWith('.js') || cliPath.endsWith('.cjs');

    // 检测 shebang（claude-internal 是带 shebang 的 JS，需要 spawn 而非 import）
    let hasShebang = false;
    if (isJsFile) {
        try {
            const fd = fs.openSync(cliPath, 'r');
            const buf = Buffer.alloc(2);
            fs.readSync(fd, buf, 0, 2, 0);
            fs.closeSync(fd);
            hasShebang = buf[0] === 0x23 && buf[1] === 0x21; // '#!'
        } catch (e) {}
    }

    if (isJsFile && !hasShebang) {
        const importUrl = pathToFileURL(cliPath).href;
        import(importUrl);
    } else {
        const args = process.argv.slice(2);
        const child = spawn(cliPath, args, { stdio: 'inherit', env: process.env });
        child.on('exit', (code) => { process.exit(code || 0); });
    }
}
```

### 5.2 编译 happy-cli

```bash
cd /path/to/happy
yarn workspace happy build
```

### 5.3 配置 ~/.zshrc

```bash
# Happy Coder 自建服务配置
export HAPPY_CLAUDE_PATH="/opt/homebrew/bin/claude-internal"   # 改为你的 Claude 路径
export HAPPY_SERVER_URL="https://your-domain.com"
export HAPPY_WEBAPP_URL="https://your-domain.com"
alias happy="node /path/to/happy/packages/happy-cli/dist/index.mjs"
```

> **注意**：`happy codex` 需要 `codex app-server` 子命令支持。
> `codex-internal`（腾讯内部版）禁用了该命令，因此只能使用 `happy`（claude-internal）。

```bash
source ~/.zshrc
```

### 5.4 绑定账号

```bash
# 首次使用，绑定 Web App 账号
happy auth login
# 浏览器会打开 https://your-domain.com/terminal/connect#key=...
# 点「接受连接」完成绑定
```

### 5.5 日常使用

```bash
happy          # 替代 claude-internal，启动 AI 会话
happy codex    # 启动 Codex
happy doctor   # 诊断环境
```

---

## 六、如何更新（与官方版本同步）

### 推荐方案：Fork 官方仓库，维护自己的分支

#### 6.1 Fork 仓库

在 GitHub 上 Fork `https://github.com/slopus/happy`，得到 `https://github.com/你的账号/happy`

```bash
# 克隆你的 fork
git clone https://github.com/你的账号/happy.git
cd happy

# 添加官方仓库为 upstream
git remote add upstream https://github.com/slopus/happy.git
git fetch upstream
```

#### 6.2 创建自定义分支

```bash
# 基于官方 main 创建自己的分支
git checkout -b self-hosted
```

你的所有自定义修改都提交到 `self-hosted` 分支：
- `claude_version_utils.cjs`（shebang 检测）
- `SELF_HOSTED_GUIDE.md`（本文档）

#### 6.3 同步官方更新

```bash
# 获取官方最新代码
git fetch upstream

# 将官方更新合并到自己的分支
git checkout self-hosted
git merge upstream/main

# 解决冲突（如有），然后重新编译
yarn workspace happy build
```

#### 6.4 更新服务器

**更新 happy-server（后端）：**

```bash
# 本地重新打包
cd /path/to/happy
tar --exclude='node_modules' --exclude='.git' \
    --exclude='packages/happy-app' \
    --exclude='packages/happy-cli' \
    --exclude='packages/happy-agent' \
    --exclude='packages/happy-app-logs' \
    -czf /tmp/happy-server-deploy.tar.gz \
    package.json yarn.lock scripts patches packages/happy-server packages/happy-wire

scp /tmp/happy-server-deploy.tar.gz root@<服务器IP>:/www/wwwroot/

# 服务器上执行
ssh root@<服务器IP>
cd /www/wwwroot/happy
tar -xzf /www/wwwroot/happy-server-deploy.tar.gz
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
SKIP_HAPPY_WIRE_BUILD=1 yarn install --frozen-lockfile --ignore-engines \
    --registry https://registry.npmmirror.com
yarn workspace @slopus/happy-wire build
yarn workspace happy-server generate

# 运行新的数据库迁移（如有）
cd packages/happy-server
set -a; source /www/wwwroot/happy/.env.prod; set +a
../../node_modules/.bin/tsx sources/standalone.ts migrate

# 重启服务
systemctl restart happy-server
```

**更新 Web App（前端）：**

```bash
# 本地重新构建
EXPO_PUBLIC_HAPPY_SERVER_URL=https://your-domain.com \
APP_ENV=production \
yarn workspace happy-app expo export --platform web \
    --output-dir packages/happy-app/dist-self-hosted

cd packages/happy-app
tar -czf /tmp/happy-webapp.tar.gz dist-self-hosted
scp /tmp/happy-webapp.tar.gz root@<服务器IP>:/www/wwwroot/

# 服务器上替换文件
ssh root@<服务器IP>
cd /www/wwwroot && tar -xzf happy-webapp.tar.gz
cp -r dist-self-hosted/* /www/wwwroot/happy-webapp/
rm -rf dist-self-hosted
# nginx 静态文件，无需重启
```

**更新本地 CLI：**

```bash
# 本地重新编译
cd /path/to/happy
yarn workspace happy build
# alias 指向 dist/index.mjs，自动生效，无需其他操作
```

---

## 七、需要维护的自定义改动清单

每次同步官方更新后，检查以下文件是否有冲突需要手动处理：

| 文件 | 改动内容 | 冲突风险 |
|---|---|---|
| `packages/happy-cli/scripts/claude_version_utils.cjs` | `runClaudeCli` 增加 shebang 检测，支持 `claude-internal` | 低 |
| `packages/happy-cli/src/codex/codexAppServerClient.ts` | `isAppServerAvailable` 和 `command` 读取 `HAPPY_CODEX_PATH` 环境变量，兼容 `codex-internal` | 低 |

其他配置（`~/.zshrc`、nginx、systemd）是独立文件，不受 git 影响，无需处理。

---

## 八、关键注意事项

1. **HTTPS 必须**：`SharedArrayBuffer`（libsodium wasm 所需）在 HTTP 下不可用，Web App 必须跑在 HTTPS 域名下
2. **API 同域反代**：Web App 和 API 必须同域（都是 `https://your-domain.com`），避免 Mixed Content 错误
3. **COEP 响应头**：nginx 必须设置 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`
4. **账号跨设备同步**：在 Web App 设置里导出备份密钥，手机扫码登录同一账号
5. **服务器数据备份**：重要数据在 `/www/wwwroot/happy-data/`，定期备份该目录

---

## 九、服务管理常用命令

```bash
# 查看服务状态
systemctl status happy-server

# 查看日志
tail -f /www/wwwroot/logs/happy-server.log

# 重启服务
systemctl restart happy-server

# 查看内存占用
free -h
```
