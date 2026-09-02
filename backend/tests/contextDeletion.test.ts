import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { contextSyncSchema } from '../src/contextSchemas.js';
import { deleteAllMemoryPalaceData } from '../src/memoryPalaceSync.js';

describe('backend deletion contracts', () => {
  it('accepts both frontend message ids and backend event ids as tombstones', () => {
    const parsed = contextSyncSchema.parse({
      clientId: 'test-client',
      user: { name: '用户', bio: '' },
      character: { id: 'char-1', name: '角色' },
      messages: [],
      memories: [],
      deletedMessageIds: [12],
      deletedEventIds: ['11111111-1111-4111-8111-111111111111'],
      deletedMemoryIds: ['memory-1'],
    });
    expect(parsed.deletedMessageIds).toEqual([12]);
    expect(parsed.deletedEventIds).toHaveLength(1);
    expect(parsed.deletedMemoryIds).toEqual(['memory-1']);
  });

  it('deletes every server-side memory-palace table for the owned characters', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111' }] });
    for (let index = 0; index < 9; index += 1) {
      query.mockResolvedValueOnce({ rows: [], rowCount: index + 1 });
    }
    const client = { query } as unknown as PoolClient;
    const result = await deleteAllMemoryPalaceData(client);
    expect(Object.keys(result)).toHaveLength(9);
    expect(result.memory_items).toBe(9);
  });
});
