#!/bin/bash
# =============================================================
# Happy CN — 自动化发布脚本
#
# 用法：
#   bash scripts/deploy.sh --frontend          # 只更新前端
#   bash scripts/deploy.sh --backend           # 只更新后端
#   bash scripts/deploy.sh --all               # 前端 + 后端
#   bash scripts/deploy.sh --cli               # 更新本地 CLI
#   bash scripts/deploy.sh --all --cli         # 全部
#
# 环境变量（可在 ~/.happy-deploy.env 中配置）：
#   HAPPY_SERVER_HOST   服务器 IP（必须）
#   HAPPY_DOMAIN        域名，如 happy.mingbaibao.com（必须）
#   HAPPY_SSH_KEY       SSH 私钥路径（默认 ~/.ssh/id_ed25519）
#   HAPPY_SERVER_USER   SSH 用户名（默认 root）
# =============================================================

set -euo pipefail

# ==================== 颜色输出 ====================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

# ==================== 配置加载 ====================
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# 加载本地配置文件（不纳入版本控制）
[ -f ~/.happy-deploy.env ] && source ~/.happy-deploy.env

SERVER_HOST="${HAPPY_SERVER_HOST:-}"
SERVER_USER="${HAPPY_SERVER_USER:-root}"
SSH_KEY="${HAPPY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DOMAIN="${HAPPY_DOMAIN:-}"
DEPLOY_DIR="/www/wwwroot/happy"
WEBAPP_DIR="/www/wwwroot/happy-webapp"

# ==================== 参数解析 ====================
DO_FRONTEND=false
DO_BACKEND=false
DO_CLI=false

if [ $# -eq 0 ]; then
    echo "用法："
    echo "  bash scripts/deploy.sh --frontend    只更新前端"
    echo "  bash scripts/deploy.sh --backend     只更新后端"
    echo "  bash scripts/deploy.sh --all         前端 + 后端"
    echo "  bash scripts/deploy.sh --cli         更新本地 CLI"
    echo "  bash scripts/deploy.sh --all --cli   全部"
    exit 0
fi

for arg in "$@"; do
    case $arg in
        --frontend) DO_FRONTEND=true ;;
        --backend)  DO_BACKEND=true ;;
        --all)      DO_FRONTEND=true; DO_BACKEND=true ;;
        --cli)      DO_CLI=true ;;
        *) die "未知参数：$arg" ;;
    esac
done

# ==================== 临时文件清理（trap 确保退出时清理） ====================
cleanup() {
    rm -f /tmp/happy-server-deploy.tar.gz
    rm -f /tmp/happy-webapp.tar.gz
}
trap cleanup EXIT

# ==================== 前置检查 ====================
if [ "$DO_FRONTEND" = true ] || [ "$DO_BACKEND" = true ]; then
    [ -z "$SERVER_HOST" ] && die "请设置 HAPPY_SERVER_HOST（或写入 ~/.happy-deploy.env）"
    [ -z "$DOMAIN" ]      && die "请设置 HAPPY_DOMAIN（或写入 ~/.happy-deploy.env）"
    [ -f "$SSH_KEY" ]     || die "SSH 密钥不存在：$SSH_KEY"

    SSH_CMD="ssh -i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes $SERVER_USER@$SERVER_HOST"

    info "检查服务器连通性..."
    $SSH_CMD 'echo ok' > /dev/null 2>&1 || die "无法连接服务器 $SERVER_HOST，请检查 SSH 配置"
    success "服务器连通"
fi

echo ""
echo "=========================================="
echo "  Happy CN — 自动化发布"
echo "  服务器：${SERVER_HOST:-本地}"
echo "  域名：${DOMAIN:-无}"
echo "=========================================="
echo ""

# ==================== 函数：等待服务健康 ====================
wait_healthy() {
    local max=30
    local i=0
    info "等待后端服务就绪..."
    while [ $i -lt $max ]; do
        if $SSH_CMD "curl -sf http://localhost:3005/health" > /dev/null 2>&1; then
            success "后端服务健康"
            return 0
        fi
        sleep 2
        i=$((i + 1))
    done
    return 1
}

# ==================== 后端部署 ====================
deploy_backend() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  [后端] 开始部署"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 1. 打包
    info "打包后端代码..."
    tar --exclude='node_modules' --exclude='.git' \
        --exclude='packages/happy-app' \
        --exclude='packages/happy-cli' \
        --exclude='packages/happy-agent' \
        --exclude='packages/happy-app-logs' \
        --exclude='environments' \
        -czf /tmp/happy-server-deploy.tar.gz \
        package.json yarn.lock patches \
        packages/happy-server packages/happy-wire

    # 2. 上传
    info "上传到服务器..."
    scp -i "$SSH_KEY" /tmp/happy-server-deploy.tar.gz \
        "$SERVER_USER@$SERVER_HOST:/tmp/"

    # 3. 服务器上执行（先停服，再更新，再启动）
    # 注意：heredoc 使用单引号 'ENDSSH' 禁用本地变量展开，所有变量均在远端求值
    info "服务器上安装并重启（先停服再操作）..."
    $SSH_CMD << 'ENDSSH'
        set -e
        export NVM_DIR="$HOME/.nvm" && [ -f "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

        DEPLOY_DIR="/www/wwwroot/happy"
        PGLITE_DIR="${PGLITE_DIR:-/www/wwwroot/happy-data/pglite}"
        BACKUP_DIR="/www/wwwroot/backups"
        TIMESTAMP=$(date +%Y%m%d_%H%M%S)

        # ① 备份当前数据库（最重要，必须成功才能继续）
        mkdir -p "$BACKUP_DIR"
        if [ -d "$PGLITE_DIR" ]; then
            cp -r "$PGLITE_DIR" "$BACKUP_DIR/pglite_$TIMESTAMP"
            echo "[backup] 数据库已备份至 $BACKUP_DIR/pglite_$TIMESTAMP"
        else
            echo "[backup] 数据库目录不存在，跳过备份：$PGLITE_DIR"
        fi

        # 备份当前后端代码
        if tar --exclude='node_modules' --exclude='.git' \
            -czf "$BACKUP_DIR/server_$TIMESTAMP.tar.gz" \
            -C "$DEPLOY_DIR" \
            packages/happy-server packages/happy-wire package.json yarn.lock 2>/dev/null; then
            echo "[backup] 代码已备份至 $BACKUP_DIR/server_$TIMESTAMP.tar.gz"
        else
            echo "[backup] ⚠️  代码备份失败（可能是首次部署），继续..."
        fi

        # 清理超过 5 份的旧备份
        ls -t "$BACKUP_DIR"/pglite_* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
        ls -t "$BACKUP_DIR"/server_*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
        echo "[backup] 备份完成（保留最近 5 份）"

        # ② 先停服
        systemctl stop happy-server || true
        echo "[server] 服务已停止"

        # ③ 停服后立即清理 pglite 锁文件，防止迁移时锁冲突
        rm -f "$PGLITE_DIR/postmaster.pid"

        # ④ 解压代码
        cd "$DEPLOY_DIR"
        tar -xzf /tmp/happy-server-deploy.tar.gz
        rm -f /tmp/happy-server-deploy.tar.gz
        echo "[server] 代码已解压"

        # ⑤ 仅在 yarn.lock 有变化时才重新安装依赖
        LOCK_FILE="$DEPLOY_DIR/yarn.lock"
        LOCK_HASH_FILE="$DEPLOY_DIR/.yarn.lock.md5"
        NEW_HASH=$(md5sum "$LOCK_FILE" | awk '{print $1}')
        OLD_HASH=$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo "")
        if [ "$NEW_HASH" != "$OLD_HASH" ]; then
            echo "[server] yarn.lock 有变化，重新安装依赖..."
            SKIP_HAPPY_WIRE_BUILD=1 yarn install \
                --frozen-lockfile --ignore-engines \
                --registry https://registry.npmmirror.com
            echo "$NEW_HASH" > "$LOCK_HASH_FILE"
            echo "[server] 依赖安装完成"
        else
            echo "[server] yarn.lock 无变化，跳过 yarn install"
        fi

        # ⑥ 构建 happy-wire
        yarn workspace @slopus/happy-wire build
        echo "[server] happy-wire 构建完成"

        # ⑦ 生成 Prisma Client
        yarn workspace happy-server generate
        echo "[server] Prisma Client 生成完成"

        # ⑧ 运行数据库迁移（停服状态下安全执行，失败直接退出触发回滚）
        cd "$DEPLOY_DIR/packages/happy-server"
        set -a; source "$DEPLOY_DIR/.env.prod"; set +a
        if ! ../../node_modules/.bin/tsx sources/standalone.ts migrate 2>&1; then
            echo "[server] ❌ 数据库迁移失败，终止部署"
            exit 1
        fi
        echo "[server] 数据库迁移完成"

        # ⑨ 启动服务
        systemctl start happy-server
        echo "[server] 服务已启动"
ENDSSH

    # 4. 验证健康，失败则自动回滚代码+数据库
    if ! wait_healthy; then
        error "后端启动失败（60s 内未就绪），执行自动回滚..."
        $SSH_CMD << 'ROLLBACK'
            set -e
            export NVM_DIR="$HOME/.nvm" && [ -f "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

            DEPLOY_DIR="/www/wwwroot/happy"
            PGLITE_DIR="${PGLITE_DIR:-/www/wwwroot/happy-data/pglite}"
            BACKUP_DIR="/www/wwwroot/backups"

            systemctl stop happy-server || true

            # 回滚数据库
            LATEST_DB_BACKUP=$(ls -td "$BACKUP_DIR"/pglite_* 2>/dev/null | head -1)
            if [ -n "$LATEST_DB_BACKUP" ]; then
                rm -rf "$PGLITE_DIR"
                cp -r "$LATEST_DB_BACKUP" "$PGLITE_DIR"
                rm -f "$PGLITE_DIR/postmaster.pid"
                echo "[rollback] ✅ 数据库已回滚至 $LATEST_DB_BACKUP"
            else
                echo "[rollback] ❌ 无可用数据库备份"
            fi

            # 回滚代码
            LATEST_CODE_BACKUP=$(ls -t "$BACKUP_DIR"/server_*.tar.gz 2>/dev/null | head -1)
            if [ -n "$LATEST_CODE_BACKUP" ]; then
                tar -xzf "$LATEST_CODE_BACKUP" -C "$DEPLOY_DIR"
                echo "[rollback] ✅ 代码已回滚至 $LATEST_CODE_BACKUP"
            else
                echo "[rollback] ❌ 无可用代码备份"
            fi

            systemctl start happy-server || true
            sleep 6
            if curl -sf http://localhost:3005/health > /dev/null 2>&1; then
                echo "[rollback] ✅ 回滚后服务恢复正常"
            else
                echo "[rollback] ❌ 回滚后服务仍异常，请手动处理"
                echo "[rollback]    ssh $SERVER_USER@$SERVER_HOST 'journalctl -u happy-server -n 50'"
            fi
ROLLBACK
        die "部署失败已尝试回滚，请查看上方日志"
    fi

    success "后端部署完成"
    echo ""
}

# ==================== 前端部署 ====================
deploy_frontend() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  [前端] 开始部署（目标域名：${DOMAIN}）"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 1. 本地构建
    info "构建 Web App..."
    EXPO_PUBLIC_HAPPY_SERVER_URL="https://$DOMAIN" \
    APP_ENV=production \
    yarn workspace happy-app expo export \
        --platform web \
        --output-dir dist-self-hosted
    success "构建完成"

    # 2. 打包（去掉 macOS xattr 扩展属性避免服务器 tar 警告）
    info "打包前端产物..."
    cd packages/happy-app
    COPYFILE_DISABLE=1 tar -czf /tmp/happy-webapp.tar.gz dist-self-hosted
    rm -rf dist-self-hosted
    cd "$REPO_DIR"

    # 3. 上传
    info "上传到服务器..."
    scp -i "$SSH_KEY" /tmp/happy-webapp.tar.gz \
        "$SERVER_USER@$SERVER_HOST:/tmp/"

    # 4. 服务器上原子替换静态文件（先解压到临时目录，再 mv 替换，避免中间状态）
    info "替换静态文件..."
    $SSH_CMD << ENDSSH
        set -e
        WEBAPP_DIR="$WEBAPP_DIR"
        cd /tmp
        tar -xzf happy-webapp.tar.gz
        # 原子替换：先移走旧目录，再 mv 新目录，避免 cp 中断导致混合状态
        rm -rf "\${WEBAPP_DIR}.old"
        mv "\$WEBAPP_DIR" "\${WEBAPP_DIR}.old" 2>/dev/null || true
        mv /tmp/dist-self-hosted "\$WEBAPP_DIR"
        rm -rf "\${WEBAPP_DIR}.old" happy-webapp.tar.gz
        echo "[webapp] 静态文件已原子替换（nginx 无需重启）"
ENDSSH

    # 5. 验证前端可访问
    info "验证前端..."
    HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "https://$DOMAIN" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        success "前端访问正常：https://$DOMAIN"
    else
        warn "前端返回 HTTP $HTTP_CODE，请手动检查 https://$DOMAIN"
    fi

    success "前端部署完成"
    echo ""
}

# ==================== CLI 本地更新 ====================
update_cli() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  [CLI] 更新本地 CLI"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 1. 安装依赖（如有变化）
    info "检查依赖..."
    yarn install --ignore-engines 2>/dev/null || true

    # 2. 构建 happy-wire（CLI 依赖）
    info "构建 happy-wire..."
    yarn workspace @slopus/happy-wire build

    # 3. 构建 CLI
    info "构建 happy-cli..."
    yarn workspace happy build

    # 4. 验证 CLI 可执行
    CLI_BIN="$REPO_DIR/packages/happy-cli/bin/happy.mjs"
    if [ -f "$CLI_BIN" ]; then
        VERSION=$(node "$CLI_BIN" --version 2>/dev/null || echo "unknown")
        success "CLI 构建完成，版本：$VERSION"
    else
        warn "CLI 二进制未找到：$CLI_BIN"
    fi

    success "CLI 更新完成"
    echo ""
}

# ==================== 执行 ====================
[ "$DO_BACKEND"  = true ] && deploy_backend
[ "$DO_FRONTEND" = true ] && deploy_frontend
[ "$DO_CLI"      = true ] && update_cli

echo "=========================================="
echo "  ✅ 发布完成！"
[ "$DO_FRONTEND" = true ] && echo "  Web App：https://$DOMAIN"
[ "$DO_BACKEND"  = true ] && echo "  后端：https://$DOMAIN/health"
echo "=========================================="
