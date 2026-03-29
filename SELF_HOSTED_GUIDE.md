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
https://your-domain.com  (nginx 反代)
    ↓ 本地
happy-server:3005  (Node.js standalone，PGlite 内嵌数据库)

Mac 终端
    ↓ happy 命令（本地源码编译版）
定制版 Claude Code
    ↓ WebSocket
https://your-domain.com
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
cd /path/to/happy-cn
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
cd /path/to/happy-cn

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

### 4.3 安装 nginx 并申请 HTTPS 证书

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

# 申请 Let's Encrypt 免费证书（自动续期）
dnf install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com \
    --non-interactive --agree-tos \
    --email your@email.com --redirect
```

### 4.4 配置完整 nginx（HTTPS + API 反代 + 必要响应头）

```bash
cat > /etc/nginx/conf.d/happy-webapp.conf << 'EOF'
server {
    server_name your-domain.com;
    root /www/wwwroot/happy-webapp;
    index index.html;

    # 启用 SharedArrayBuffer（加密库 wasm 必需）
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

    # Socket.IO 反代（WebSocket 实时通信）
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

### 5.1 编译 happy-cli

```bash
cd /path/to/happy-cn
yarn workspace happy build
```

### 5.2 配置 ~/.zshrc

**场景一（中转 API，使用标准 claude）：**
```bash
export HAPPY_SERVER_URL="https://your-domain.com"
export HAPPY_WEBAPP_URL="https://your-domain.com"
alias happy="node ~/happy-cn/packages/happy-cli/dist/index.mjs"
```

**场景二（公司定制版）：**
```bash
export HAPPY_CLAUDE_PATH="/path/to/your-custom-claude"  # 改为你的定制版路径
export HAPPY_SERVER_URL="https://your-domain.com"
export HAPPY_WEBAPP_URL="https://your-domain.com"
alias happy="node ~/happy-cn/packages/happy-cli/dist/index.mjs"
```

```bash
source ~/.zshrc
```

### 5.3 注册账号 + 绑定终端

```bash
# 浏览器打开 https://your-domain.com，点「Create account」注册
# 然后运行：
happy auth login
# 浏览器弹出授权页，点「接受连接」完成绑定
```

### 5.4 日常使用

```bash
happy        # 启动 Claude Code，支持远程控制
happy doctor # 诊断环境问题
```

---

## 六、如何同步官方更新

```bash
# 添加上游仓库（只需一次）
git remote add upstream https://github.com/slopus/happy.git

# 获取官方最新代码并合并
git fetch upstream
git merge upstream/main

# 重新编译
yarn workspace happy build
```

**合并后需要检查的文件：**

| 文件 | 我们的改动 | 冲突风险 |
|---|---|---|
| `packages/happy-cli/scripts/claude_version_utils.cjs` | shebang 检测，支持定制版脚本 | 低 |

---

## 七、更新已部署的服务

**更新 happy-server（后端）：**

```bash
# 本地重新打包
cd /path/to/happy-cn
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

# 服务器上替换（nginx 静态文件，无需重启）
ssh root@<服务器IP>
cd /www/wwwroot && tar -xzf happy-webapp.tar.gz
cp -r dist-self-hosted/* /www/wwwroot/happy-webapp/
rm -rf dist-self-hosted
```

---

## 八、关键注意事项

1. **HTTPS 必须**：`SharedArrayBuffer`（加密库 wasm 所需）在 HTTP 下不可用，Web App 必须跑在 HTTPS 域名下
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
