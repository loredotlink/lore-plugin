# lore-cowork MCP server binary

This directory holds the compiled MCP server that ships with the
lore-cowork plugin. The plugin's `.mcp.json` hardcodes the path
`lore-cowork/server/lore-cowork-mcp` — so the binary lives here, it's
committed to git, and `/plugin install` gets a working server with no
build step on the user's machine.

## Build

```bash
bash lore-cowork/scripts/build.sh
```

The script `cd`s into `lore-cowork/` regardless of caller cwd, then
runs:

```bash
bun build --compile --target=bun-darwin-arm64 \
  server-src/index.ts --outfile server/lore-cowork-mcp
```

Source for the server lives in `lore-cowork/server-src/`. See
[`../DESIGN.md`](../DESIGN.md) for the overall architecture.

## Target

**`bun-darwin-arm64` only** for v1. Cross-targets (linux-x64,
darwin-x64, linux-arm64) are intentionally out of scope until there's a
second OS/arch worth supporting. The compiled binary is a fully
self-contained Bun runtime — no `node`/`bun` required on the user's
machine, but it will only run on Apple Silicon macOS.

## Rebuild requirement

The binary **must** be rebuilt whenever anything under
`lore-cowork/server-src/**` changes. CI (Task 9) enforces this by
running the build script and failing the job if
`git diff --exit-code lore-cowork/server/lore-cowork-mcp` shows
unstaged changes.

If you forget: rebase, run `bash lore-cowork/scripts/build.sh`, and
amend or add a follow-up commit.

## Bun version

Built and tested with **Bun 1.3.10**. Run `bun --version` locally to
confirm before building — `bun build --compile` output is sensitive to
the Bun version, and CI pins Bun explicitly. If you need to bump the
Bun version, update this README in the same PR.

## Committing the binary in a sandboxed environment

`git add lore-cowork/server/lore-cowork-mcp` can OOM under sandboxed
process limits (Claude Code, restricted shells) because git's default
delta compression on a 60+ MB blob spikes memory. Workaround:

```bash
git -c core.bigFileThreshold=1m -c core.compression=0 \
  add lore-cowork/server/lore-cowork-mcp
```

This stores the blob as a loose object without delta/zlib work and
sidesteps the spike. The resulting blob is identical (just a different
on-disk representation); normal `git push` / CI works unchanged.
Unsandboxed local shells generally don't need this.
