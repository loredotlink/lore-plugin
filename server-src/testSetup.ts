/**
 * bun-test preload (wired via `bunfig.toml`). Runs once, before any test file
 * is imported, so it is the right place to make the whole suite safe (TAN-5045):
 *
 *  1. Set `LORE_PLUGIN_TEST_SANDBOX=1` so module-load side effects that would
 *     infer and set `LORE_PLUGIN_STATE_DIR` (e.g. `amp/lore.ts`) stay no-ops.
 *     This restores per-`home` test isolation — matching CI, where no such
 *     side effect fires.
 *  2. Arm a hard tripwire that throws if anything still tries to write into the
 *     developer's real `~/.lore`, so a future regression fails loudly instead
 *     of silently overwriting real credentials.
 */
import { armRealLoreWriteGuard } from './testSandbox';

process.env.LORE_PLUGIN_TEST_SANDBOX = '1';
armRealLoreWriteGuard();
