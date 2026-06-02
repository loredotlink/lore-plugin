import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { copyToClipboard } from './clipboard';

const originalPath = process.env.PATH;
let stubBinDir: string;

beforeEach(async () => {
  stubBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-plugin-clipboard-stub-'));
  process.env.PATH = stubBinDir;
});

afterEach(async () => {
  if (originalPath === undefined) Reflect.deleteProperty(process.env, 'PATH');
  else process.env.PATH = originalPath;
  await fs.rm(stubBinDir, { recursive: true, force: true });
});

async function writeStubBinary(name: string, body: string): Promise<void> {
  const fullPath = path.join(stubBinDir, name);
  await fs.writeFile(fullPath, body);
  await fs.chmod(fullPath, 0o755);
}

describe('copyToClipboard', () => {
  test('returns false when no clipboard tool is on PATH', async () => {
    const ok = await copyToClipboard('hello');
    expect(ok).toBe(false);
  });

  if (os.platform() === 'darwin') {
    test('uses pbcopy on macOS and reports success when it exits 0', async () => {
      const captureFile = path.join(stubBinDir, 'captured.txt');
      await writeStubBinary(
        'pbcopy',
        `#!/bin/bash\n/bin/cat > ${JSON.stringify(captureFile)}\n`,
      );

      const ok = await copyToClipboard('payload', { timeoutMs: 5000 });
      expect(ok).toBe(true);

      const captured = await fs.readFile(captureFile, 'utf8');
      expect(captured).toBe('payload');
    });

    test('returns false when pbcopy exits non-zero', async () => {
      await writeStubBinary('pbcopy', '#!/bin/bash\nexit 17\n');
      const ok = await copyToClipboard('payload', { timeoutMs: 5000 });
      expect(ok).toBe(false);
    });
  }
});
