import { describe, expect, it } from 'vitest';
import { memoryPalaceReconcileSchema, memoryPalaceSyncSchema } from '../src/memoryPalaceSchemas.js';

describe('memory palace migration schemas', () => {
  it('accepts every active and legacy Memory Palace store in one snapshot', () => {
    const parsed = memoryPalaceSyncSchema.parse({
      clientId: 'browser-test',
      characterId: 'char-1',
      snapshotId: 'snapshot-1',
      eventBoxes: [{
        id: 'box-1', name: '初见', tags: ['初见'], summaryNodeId: null,
        liveMemoryIds: ['memory-1'], archivedMemoryIds: [], compressionCount: 0,
        createdAt: 1, updatedAt: 2, lastCompressedAt: null, sealed: false,
      }],
      roomPlates: [{
        id: 'char-1:user_room', room: 'user_room', version: 1, updatedAt: 2,
        entries: [{ id: 'entry-1', text: '用户喜欢雨天。', firstLearnedAt: 1, updatedAt: 2, sourceCount: 2 }],
      }],
      links: [{ id: 'link-1', sourceId: 'memory-1', targetId: 'memory-2', type: 'temporal', strength: 0.8 }],
      anticipations: [{ id: 'ant-1', content: '下次继续聊。', status: 'active', createdAt: 2, anchoredAt: null, resolvedAt: null }],
      digestReports: [{
        id: 'report-1', createdAt: 2, trigger: 'manual', examined: [], outcomes: [],
        plateSubmissions: [], plateUpdated: ['user_room'],
      }],
      vectors: [{ memoryId: 'memory-1', dimensions: 1, model: 'embedding-test', vectorBase64: 'AAAAAA==' }],
      batches: [{
        id: 'batch-1', eventBoxId: 'box-1', status: 'done', nodesCreated: 1,
        error: null, createdAt: 1, completedAt: 2,
      }],
      topicBoxes: [{
        id: 'topic-1', messageIds: [1, 2], status: 'sealed', topic: '旧话题',
        events: ['见面'], keywords: ['初见'], createdAt: 1, sealedAt: 2,
      }],
    });

    expect(parsed.eventBoxes).toHaveLength(1);
    expect(parsed.roomPlates[0]?.entries).toHaveLength(1);
    expect(parsed.vectors[0]?.vectorBase64).toBe('AAAAAA==');
    expect(parsed.topicBoxes[0]?.status).toBe('sealed');
    expect(parsed.deletions.linkIds).toEqual([]);
  });

  it('accepts exact incremental deletes without a full reconciliation snapshot', () => {
    const parsed = memoryPalaceSyncSchema.parse({
      clientId: 'browser-test',
      characterId: 'char-1',
      deletions: {
        linkIds: ['link-1'],
        vectorMemoryIds: ['memory-1'],
      },
    });

    expect(parsed.snapshotId).toBeUndefined();
    expect(parsed.deletions.linkIds).toEqual(['link-1']);
    expect(parsed.deletions.vectorMemoryIds).toEqual(['memory-1']);
    expect(parsed.eventBoxes).toEqual([]);
  });

  it('requires a complete ID manifest before backend reconciliation', () => {
    expect(() => memoryPalaceReconcileSchema.parse({ characterId: 'char-1' })).toThrow();
    expect(memoryPalaceReconcileSchema.parse({
      characterId: 'char-1',
      snapshotId: 'snapshot-1',
    }).characterId).toBe('char-1');
  });
});
