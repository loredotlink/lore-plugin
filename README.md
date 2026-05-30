# Lore plugin

Source of truth lives in `tanagram/lore` under `packages/lore-plugin`. The
standalone `tanagram/lore-plugin` repository is mirrored from this directory.

Share your Claude Code, Cowork, Codex, or Amp session to [Lore](https://lore.tanagram.ai) and read threads back, without leaving the agent.

## Install

### Claude Code

From inside a session, run `/plugins` to open the interactive plugins TUI:

```text
/plugins
```

In the TUI, switch to the **Marketplaces** tab, choose **Add Marketplace**, enter `tanagram/lore-plugin`, then open the new **tanagram** marketplace and install the **Lore** plugin.

From a plain terminal (outside a session), you can do it in one shot:

```bash
claude plugin marketplace add tanagram/lore-plugin
claude plugin install lore@tanagram
```

### Codex

Codex uses the same shared package through [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json).

### Amp

Amp does not use the Claude/Codex manifests. Amp loads TypeScript plugins from local files:

- Project plugin: `.amp/plugins/*.ts`
- System plugin: `~/.config/amp/plugins/*.ts`

For a user-level install from the published plugin repository, copy-paste the full block below:

```bash
if [ -d ~/.local/share/lore-plugin/.git ]; then
  git -C ~/.local/share/lore-plugin pull --ff-only
else
  git clone https://github.com/tanagram/lore-plugin ~/.local/share/lore-plugin
fi

cd ~/.local/share/lore-plugin
bun install --frozen-lockfile

mkdir -p ~/.config/amp/plugins
ln -sf ~/.local/share/lore-plugin/amp/lore.ts ~/.config/amp/plugins/lore.ts

amp plugins list
```

Then reload plugins from Amp's command palette with `plugins: reload`. The command palette should show **Lore: Share active Amp thread**. `amp plugins list` should include:

```text
✓ /Users/.../.config/amp/plugins/lore.ts active
  Command: Lore: Share active Amp thread
  Tool: share_current_amp_thread
  Tool: lore_login
  Tool: lore_login_resume
  Tool: get_thread
  Tool: list_threads
  Tool: search_threads
```

The canonical Amp implementation is [`amp/lore.ts`](./amp/lore.ts). This package also includes [`./.amp/plugins/lore.ts`](./.amp/plugins/lore.ts), a thin Amp-layout entrypoint that delegates to the canonical implementation without duplicating command or tool registration. Keep that package layout intact; neither `.amp/plugins/lore.ts` nor `amp/lore.ts` is standalone — they import shared files from this checkout.

For local development in the Lore monorepo, run Amp from `packages/lore-plugin` so it can load `packages/lore-plugin/.amp/plugins/lore.ts`. For a user-level local install while iterating on a monorepo checkout, symlink the canonical Amp implementation file and keep the relative package files available:

```bash
mkdir -p ~/.config/amp/plugins
ln -s "$(pwd)/packages/lore-plugin/amp/lore.ts" ~/.config/amp/plugins/lore.ts
```

If you run those commands from `packages/lore-plugin`, use `$(pwd)/amp/lore.ts` as the symlink target instead.

## What you get

- **`share`** — in Claude Code/Cowork/Codex, post the current local session to Lore. Returns a shareable URL, plus a brief note if your session included uploaded or generated files. Visibility is private in v1; re-share from the Lore web UI to make a thread workspace-visible.
- **`Lore: Share active Amp thread`** — in Amp, export the active Amp thread with the local Amp CLI, upload the raw export to Lore as `harness: 'amp'`, include the Lore URL in the notification, append it back into the Amp thread, copy it to the clipboard, and show it in a copyable dialog only when the thread append or clipboard copy is unavailable.
- **`share_current_amp_thread`** — an Amp tool for explicit natural-language invocation. It accepts `{ thread_id?: string, visibility?: 'private' | 'workspace' | 'public', highlight?: string }`; if `thread_id` is omitted, `AMP_CURRENT_THREAD_ID` must be set or the tool returns an actionable error. `highlight` is a natural-language description of the block or block range to emphasize in the returned Lore URL.
- **`lore` / read tools** — fetch a Lore thread by ID or URL, or list and search threads by title.

Natural-language phrasings work in hosts that surface the plugin tools and skills on every turn. Amp's safe MVP is explicit: use the command-palette share command for the active thread, or call `share_current_amp_thread` with a known Amp `thread_id`. The Amp tool does not guess the active thread from undocumented tool context.

## First-time setup

The first time you use `share`, `lore`, or the Amp share/read tools, the plugin's `lore_login` tool opens a browser to the WorkOS AuthKit consent screen with a device code pre-filled. Sign in, click Allow, and the tool returns. The plugin persists tokens under `~/Library/Application Support/tanagram/lore/tokens.json` (mode 0600) and refreshes them silently on subsequent calls. If the browser cannot be opened automatically (SSH, no GUI), `lore_login` returns a `verification_uri` + `device_code` and the agent calls `lore_login_resume` once you complete the flow on another device.

## Architecture

The shared package contains host-specific manifests for Claude Code and Codex, an Amp TypeScript plugin entrypoint, one bundled stdio MCP server that reads Claude/Cowork/Codex local session bytes off disk, and the proxy/auth code that talks to the Lore cloud MCP at `https://lore.tanagram.ai/mcp`. The stdio binary is a Bun-compiled single executable. Auth runs in-process via the `lib/auth/` library: RFC 8628 device-code flow against WorkOS AuthKit, discovery-driven (PRM → AS metadata, cached at `~/Library/Application Support/tanagram/lore/discovery-cache.json`), with silent refresh and 401-triggered re-login. See [`DESIGN.md`](./DESIGN.md) for the full breakdown.

Amp sharing is host-specific because Amp sessions are exported through `amp threads export <thread_id>` instead of the shared on-disk session detector. The Amp command and natural-language tool both call the same `shareAmpThread` helper, which delegates upload/auth behavior to the existing `runShareSession` core.

Share tools support optional highlighted links. When a caller passes `highlight`, Lore resolves the description against parsed thread blocks and returns a `thread_url` with a `#block` or `#start-end` anchor when it finds a confident match. If highlight resolution fails or times out, sharing still succeeds and returns the base thread URL.

The human-facing prompts now live under [`skills/`](./skills) rather than a separate `commands/` tree so the package layout is shared across agents.

## Requirements and limitations

- macOS arm64 only for the packaged stdio MCP binary in v1. The plugin ships a precompiled Bun binary for Apple Silicon — Intel Macs and Linux are out of scope for now.
- Amp sharing requires the local `amp` CLI to be installed and able to run `amp threads export <thread_id>`.
- Amp installation is local file-based for now. Do not assume an Amp marketplace distribution exists.
- Amp active-thread sharing is command-palette based. Natural-language sharing is available through the explicit `share_current_amp_thread` tool when a thread ID is supplied or `AMP_CURRENT_THREAD_ID` is present; automatic agent-context injection may come later.

## License

MIT
