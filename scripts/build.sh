#!/usr/bin/env bash
#
# Build the lore MCP server into a single self-contained binary.
#
# Why: `.mcp.json` in the published plugin hardcodes the path
# `server/lore-mcp`. Committing the compiled binary
# means `/plugin install` ships a working server with no second-step
# build on the user's machine.
#
# Target: bun-darwin-arm64 only for v1. Cross-targets are intentionally
# out of scope until we have a second OS/arch worth supporting.
#
# Usage:
#   bash packages/lore-plugin/scripts/build.sh # from lore monorepo root
#   bash scripts/build.sh                       # from packages/lore-plugin
#   ./scripts/build.sh                          # from packages/lore-plugin
#
# The script `cd`s to the package root regardless of caller cwd so
# relative paths in the bun invocation resolve predictably.

set -euo pipefail

# Resolve the directory of this script, then cd to the package root.
# Robust against symlinks and arbitrary caller cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

echo "Building lore-mcp (bun-darwin-arm64)..." >&2
echo "  bun: $(bun --version)" >&2
echo "  cwd: $(pwd)" >&2

bun build \
  --compile \
  --target=bun-darwin-arm64 \
  server-src/index.ts \
  --outfile server/lore-mcp

chmod +x server/lore-mcp

echo "Built: $(pwd)/server/lore-mcp" >&2
ls -la server/lore-mcp >&2
