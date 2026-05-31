import { describe, test, expect } from 'bun:test';
import { tools } from './index';

describe('tools barrel', () => {
  test('exports local, login, and cloud proxy tools', () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      'list_local_sessions',
      'read_local_session',
      'lore_login',
      'lore_login_resume',
      'share_session',
      'list_threads',
      'get_thread',
      'search_threads',
    ]);
  });

  test('does not register duplicate tool names', () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
