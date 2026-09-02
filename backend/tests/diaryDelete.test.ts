import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { deleteDiaryWithEvents } from '../src/diaries.js';

describe('deleteDiaryWithEvents', () => {
  it('removes source events before deleting the diary row', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        character_external_id: 'character-1',
        character_name: 'Tester',
      }] })
      .mockResolvedValueOnce({ rows: [
        { event_id: '21111111-1111-4111-8111-111111111111' },
        { event_id: '31111111-1111-4111-8111-111111111111' },
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await expect(deleteDiaryWithEvents(client, '11111111-1111-4111-8111-111111111111')).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[2]?.[0])).toContain('DELETE FROM conversation_events');
    expect(String(query.mock.calls[3]?.[0])).toContain('DELETE FROM agent_diaries');
  });

  it('does nothing when the diary is not owned by the current user', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;
    await expect(deleteDiaryWithEvents(client, '11111111-1111-4111-8111-111111111111')).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
