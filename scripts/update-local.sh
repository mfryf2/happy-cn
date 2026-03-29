#!/bin/bash
# =============================================================
# 本地一键更新脚本
# 功能：同步官方最新代码，保留自定义改动，重新编译 CLI
# 用法：bash scripts/update-local.sh
# =============================================================

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "=========================================="
echo "  Happy CN — 本地一键更新"
echo "=========================================="
echo ""

# 1. 检查 upstream 是否已添加
if ! git remote get-url upstream &>/dev/null; then
    echo "➕ 添加官方上游仓库..."
    git remote add upstream https://github.com/slopus/happy.git
fi

# 2. 拉取官方最新代码
echo "📡 获取官方最新代码..."
git fetch upstream

# 检查是否有更新
LOCAL=$(git rev-parse main)
UPSTREAM=$(git rev-parse upstream/main)

if [ "$LOCAL" = "$UPSTREAM" ]; then
    echo "✅ 已是最新版本，无需更新"
    exit 0
fi

echo ""
echo "📋 官方更新内容："
git log --oneline main..upstream/main | head -20
echo ""

# 3. 合并官方更新
echo "🔀 合并官方更新..."
if ! git merge upstream/main --no-edit; then
    echo ""
    echo "⚠️  合并时出现冲突，请手动解决后运行："
    echo "   git add . && git commit"
    echo "   bash scripts/update-local.sh --skip-merge"
    exit 1
fi

# 4. 重新安装依赖（如果 package.json 有变化）
echo ""
echo "📦 检查依赖变化..."
yarn install --frozen-lockfile --ignore-engines 2>/dev/null || yarn install --ignore-engines

# 5. 重新编译 CLI
echo ""
echo "🔨 重新编译 happy-cli..."
yarn workspace @slopus/happy-wire build
yarn workspace happy build

# 6. 推送到自己的 fork
echo ""
echo "☁️  推送到 GitHub..."
git push myfork main 2>/dev/null || git push origin main 2>/dev/null || echo "⚠️  推送失败，请手动推送"

echo ""
echo "=========================================="
echo "  ✅ 本地更新完成！"
echo "  CLI 已重新编译，直接运行 happy 即可使用"
echo "=========================================="
