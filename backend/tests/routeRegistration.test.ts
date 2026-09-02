import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('backend route registration', () => {
  it('registers every route module used by SharkOS exactly once from the API composition root', () => {
    const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
    const modules = [
      'Context',
      'Chat',
      'ModelProfile',
      'MemoryPalace',
      'AgentSettings',
      'Diary',
      'Push',
      'Pairing',
      'ToolConnection',
      'PhonePeek',
    ];

    for (const moduleName of modules) {
      const registration = `await register${moduleName}Routes(app)`;
      expect(apiSource.split(registration)).toHaveLength(2);
    }

    const chatSource = readFileSync(new URL('../src/chat.ts', import.meta.url), 'utf8');
    expect(chatSource).not.toContain('registerModelProfileRoutes');
  });
});
