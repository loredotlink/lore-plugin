/**
 * Tests for consentSurface.ts (text-only surface — ADR-0007).
 *
 * Verifies:
 *   - buildConsentSurface returns text + structuredContent, never a
 *     `{ type: 'resource' }` block and never `_meta`.
 *   - macSupported / consent variants carry the right copy and structured flags.
 *   - buildConsentSurface is pure (no I/O, deterministic).
 */
import { describe, test, expect } from 'bun:test';
import { buildConsentSurface } from './consentSurface.js';

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
