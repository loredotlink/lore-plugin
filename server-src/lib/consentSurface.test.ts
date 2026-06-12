/**
 * Tests for consentSurface.ts (text-only surface — ADR-0007).
 *
 * Verifies:
 *   - buildConsentSurface returns text + structuredContent, never a
 *     `{ type: 'resource' }` block and never `_meta`.
 *   - macSupported / consent variants carry the right copy and structured flags.
 *   - buildSetupStatus returns a text-only result per consent state.
 *   - Both functions are pure (no I/O, deterministic).
 */
import { describe, test, expect } from 'bun:test';
import { buildConsentSurface, buildSetupStatus } from './consentSurface.js';

type TextBlock = { type: 'text'; text: string };

function textOf(result: { content: unknown[] }): string {
  return (result.content as Array<{ type: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => (b as TextBlock).text)
    .join('\n');
}

function resourceBlocks(result: { content: unknown[] }): unknown[] {
  return (result.content as Array<{ type: string }>).filter(
    (b) => b.type === 'resource',
  );
}

describe('buildConsentSurface — macSupported: true, unconsented', () => {
  const result = buildConsentSurface({
    macSupported: true,
    consent: 'unconsented',
  });

  test('returns content + structuredContent', () => {
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.structuredContent).toBeDefined();
  });

  test('structuredContent reflects consent + macSupported', () => {
    expect(result.structuredContent).toMatchObject({
      consent: 'unconsented',
      macSupported: true,
    });
  });

  test('has exactly one text block', () => {
    const textBlocks = (result.content as Array<{ type: string }>).filter(
      (b) => b.type === 'text',
    );
    expect(textBlocks).toHaveLength(1);
  });

  test('has NO resource block', () => {
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('result carries no _meta', () => {
    expect('_meta' in result).toBe(false);
  });

  test('text names lore_consent and includes both approve: true and approve: false', () => {
    const text = textOf(result);
    expect(text).toContain('lore_consent');
    expect(text).toContain('approve: true');
    expect(text).toContain('approve: false');
  });

  test('text discloses the background helper and the multi-dimensional allowlist', () => {
    const text = textOf(result);
    expect(text).toMatch(/background/i);
    // Interim-trust copy: allowlist is multi-dimensional and the default
    // is never-public. It must NOT claim local secret scrubbing (Phase 2).
    expect(text).toMatch(/repos, directories, or skills/i);
    expect(text).toMatch(/never public/i);
    expect(text).not.toMatch(/scrub/i);
  });

  test('text includes a status line', () => {
    expect(textOf(result)).toMatch(/status/i);
  });
});

describe('buildConsentSurface — macSupported: false', () => {
  const result = buildConsentSurface({
    macSupported: false,
    consent: 'unconsented',
  });

  test('structuredContent.macSupported === false', () => {
    expect(result.structuredContent).toMatchObject({ macSupported: false });
  });

  test('has NO resource block', () => {
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('text mentions platform unavailability', () => {
    expect(textOf(result)).toMatch(/platform|unavailable|not available/i);
  });

  test('text does NOT include approve: true', () => {
    expect(textOf(result)).not.toContain('approve: true');
  });

  test('text still offers the skip path (approve: false)', () => {
    expect(textOf(result)).toContain('approve: false');
  });
});

describe('buildConsentSurface — consent: declined', () => {
  const result = buildConsentSurface({
    macSupported: true,
    consent: 'declined',
  });

  test('structuredContent reflects declined', () => {
    expect(result.structuredContent).toMatchObject({
      consent: 'declined',
      macSupported: true,
    });
  });

  test('has NO resource block', () => {
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('text reflects re-opening the decision', () => {
    expect(textOf(result)).toMatch(/re-open/i);
  });

  test('text still includes both approve: true and approve: false', () => {
    const text = textOf(result);
    expect(text).toContain('approve: true');
    expect(text).toContain('approve: false');
  });
});

describe('buildConsentSurface — purity', () => {
  test('called twice with the same args produces identical output', () => {
    const a = buildConsentSurface({ macSupported: true, consent: 'unconsented' });
    const b = buildConsentSurface({ macSupported: true, consent: 'unconsented' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildSetupStatus', () => {
  test('returns a text-only CallToolResult', () => {
    const result = buildSetupStatus('unconsented');
    expect(Array.isArray(result.content)).toBe(true);
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('unconsented state describes how to enable', () => {
    const text = textOf(buildSetupStatus('unconsented'));
    expect(text).toMatch(/consent|enable|lore_consent/i);
  });

  test('consented state describes the disable affordance', () => {
    const text = textOf(buildSetupStatus('consented'));
    expect(text).toMatch(/consent/i);
    expect(text).toContain('approve: false');
  });

  test('declined state describes current state and how to enable', () => {
    const text = textOf(buildSetupStatus('declined'));
    expect(text).toMatch(/declined|skipped|disabled/i);
  });

  test('capturing state reflects active capture', () => {
    const text = textOf(buildSetupStatus('capturing'));
    expect(text).toMatch(/captur|active|running/i);
  });

  test('installed state reflects installation', () => {
    expect(textOf(buildSetupStatus('installed'))).toMatch(/install/i);
  });

  test('idle state reflects idle watcher', () => {
    expect(textOf(buildSetupStatus('idle'))).toMatch(/idle|paused|inactive/i);
  });

  test('is pure — called twice with same args produces identical output', () => {
    const a = buildSetupStatus('consented');
    const b = buildSetupStatus('consented');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
