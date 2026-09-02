import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contextSyncSchema } from '../src/contextSchemas.js';
import { memoryToKind, messageRoleToEventType, millisToDate } from '../src/contextMapping.js';

describe('context sync mapping', () => {
  it('maps SullyOS roles to typed backend events', () => {
    expect(messageRoleToEventType('user')).toBe('user_message');
    expect(messageRoleToEventType('assistant')).toBe('assistant_message');
    expect(messageRoleToEventType('system')).toBe('system_event');
  });

  it('keeps event-box summaries distinguishable from ordinary memories', () => {
    expect(memoryToKind({ isBoxSummary: true })).toBe('summary');
    expect(memoryToKind({ isBoxSummary: false })).toBe('episode');
  });

  it('converts SullyOS millisecond timestamps without losing time', () => {
    expect(millisToDate(1_700_000_000_123)?.getTime()).toBe(1_700_000_000_123);
    expect(millisToDate(undefined)).toBeNull();
  });

  it('does not accept unrelated API credentials into the context payload', () => {
    const parsed = contextSyncSchema.parse({
      clientId: 'browser-test',
      apiConfig: { apiKey: 'must-not-be-synced' },
      user: { name: 'User', bio: '' },
      character: {
        id: 'char-1',
        name: 'Sully',
        description: '',
        systemPrompt: '',
      },
    });

    expect('apiConfig' in parsed).toBe(false);
  });

  it('reads character metadata from the synchronized profile column', () => {
    const source = readFileSync(new URL('../src/contextBuilder.ts', import.meta.url), 'utf8');

    expect(source).toContain('a.profile_metadata AS metadata');
    expect(source).not.toContain('a.metadata');
  });
});
