import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { millisToDate } from './contextMapping.js';
import { pool } from './db.js';
import {
  memoryPalaceReconcileSchema,
  memoryPalaceSyncSchema,
  type MemoryPalaceReconcileInput,
  type MemoryPalaceSyncInput,
} from './memoryPalaceSchemas.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

async function resolveAgentId(client: PoolClient, characterId: string): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM characters WHERE owner_user_id = $1 AND external_id = $2 LIMIT 1',
    [DEFAULT_USER_ID, characterId],
  );
  return result.rows[0]?.id ?? null;
}

export async function syncMemoryPalace(input: MemoryPalaceSyncInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const agentId = await resolveAgentId(client, input.characterId);
    if (!agentId) throw new Error('memory_palace_character_not_synced');

    for (const box of input.eventBoxes) {
      await client.query(
        `INSERT INTO memory_event_boxes
         (agent_id, external_id, name, tags, summary_node_external_id, live_memory_external_ids,
          archived_memory_external_ids, compression_count, sealed, predecessor_box_external_id,
          client_created_at, client_updated_at, last_compressed_at, sync_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          name=EXCLUDED.name, tags=EXCLUDED.tags, summary_node_external_id=EXCLUDED.summary_node_external_id,
          live_memory_external_ids=EXCLUDED.live_memory_external_ids,
          archived_memory_external_ids=EXCLUDED.archived_memory_external_ids,
          compression_count=EXCLUDED.compression_count, sealed=EXCLUDED.sealed,
          predecessor_box_external_id=EXCLUDED.predecessor_box_external_id,
          client_created_at=EXCLUDED.client_created_at, client_updated_at=EXCLUDED.client_updated_at,
          last_compressed_at=EXCLUDED.last_compressed_at,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_event_boxes.sync_snapshot_id),
          updated_at=now()`,
        [agentId, box.id, box.name, box.tags, box.summaryNodeId, box.liveMemoryIds,
          box.archivedMemoryIds, box.compressionCount, box.sealed, box.predecessorBoxId ?? null,
          millisToDate(box.createdAt), millisToDate(box.updatedAt), millisToDate(box.lastCompressedAt),
          input.snapshotId ?? null],
      );
    }

    for (const plate of input.roomPlates) {
      await client.query(
        `INSERT INTO memory_room_plates
         (agent_id, external_id, room, entries, version, client_updated_at, sync_snapshot_id)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          room=EXCLUDED.room, entries=EXCLUDED.entries, version=EXCLUDED.version,
          client_updated_at=EXCLUDED.client_updated_at,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_room_plates.sync_snapshot_id),
          updated_at=now()`,
        [agentId, plate.id, plate.room, JSON.stringify(plate.entries), plate.version,
          millisToDate(plate.updatedAt), input.snapshotId ?? null],
      );
    }

    if (input.links.length > 0) {
      await client.query(
        `INSERT INTO memory_links
         (agent_id, external_id, source_memory_external_id, target_memory_external_id, link_type, strength, sync_snapshot_id)
         SELECT $1, item.id, item."sourceId", item."targetId", item.type, item.strength, $3
         FROM jsonb_to_recordset($2::jsonb) AS item(
           id text,
           "sourceId" text,
           "targetId" text,
           type text,
           strength double precision
         )
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          source_memory_external_id=EXCLUDED.source_memory_external_id,
          target_memory_external_id=EXCLUDED.target_memory_external_id,
          link_type=EXCLUDED.link_type, strength=EXCLUDED.strength,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_links.sync_snapshot_id),
          updated_at=now()`,
        [agentId, JSON.stringify(input.links), input.snapshotId ?? null],
      );
    }

    for (const anticipation of input.anticipations) {
      await client.query(
        `INSERT INTO memory_anticipations
         (agent_id, external_id, content, status, client_created_at, anchored_at, resolved_at, sync_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          content=EXCLUDED.content, status=EXCLUDED.status, client_created_at=EXCLUDED.client_created_at,
          anchored_at=EXCLUDED.anchored_at, resolved_at=EXCLUDED.resolved_at,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_anticipations.sync_snapshot_id),
          updated_at=now()`,
        [agentId, anticipation.id, anticipation.content, anticipation.status,
          millisToDate(anticipation.createdAt), millisToDate(anticipation.anchoredAt),
          millisToDate(anticipation.resolvedAt), input.snapshotId ?? null],
      );
    }

    for (const report of input.digestReports) {
      await client.query(
        `INSERT INTO memory_digest_reports
         (agent_id, external_id, trigger_type, examined, outcomes, plate_submissions,
          plate_updated, client_created_at, sync_snapshot_id)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9)
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          trigger_type=EXCLUDED.trigger_type, examined=EXCLUDED.examined, outcomes=EXCLUDED.outcomes,
          plate_submissions=EXCLUDED.plate_submissions, plate_updated=EXCLUDED.plate_updated,
          client_created_at=EXCLUDED.client_created_at,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_digest_reports.sync_snapshot_id),
          updated_at=now()`,
        [agentId, report.id, report.trigger, JSON.stringify(report.examined), JSON.stringify(report.outcomes),
          JSON.stringify(report.plateSubmissions), report.plateUpdated, millisToDate(report.createdAt),
          input.snapshotId ?? null],
      );
    }

    for (const vector of input.vectors) {
      await client.query(
        `INSERT INTO memory_vectors
         (agent_id, memory_external_id, dimensions, model, vector_data, sync_snapshot_id)
         VALUES ($1,$2,$3,$4,decode($5, 'base64'),$6)
         ON CONFLICT (agent_id, memory_external_id) DO UPDATE SET
          dimensions=EXCLUDED.dimensions, model=EXCLUDED.model,
          vector_data=EXCLUDED.vector_data,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_vectors.sync_snapshot_id),
          updated_at=now()`,
        [agentId, vector.memoryId, vector.dimensions, vector.model ?? null, vector.vectorBase64,
          input.snapshotId ?? null],
      );
    }

    for (const batch of input.batches) {
      await client.query(
        `INSERT INTO memory_batches
         (agent_id, external_id, event_box_external_id, status, nodes_created,
          error_message, client_created_at, client_completed_at, sync_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          event_box_external_id=EXCLUDED.event_box_external_id, status=EXCLUDED.status,
          nodes_created=EXCLUDED.nodes_created, error_message=EXCLUDED.error_message,
          client_created_at=EXCLUDED.client_created_at,
          client_completed_at=EXCLUDED.client_completed_at,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_batches.sync_snapshot_id),
          updated_at=now()`,
        [agentId, batch.id, batch.eventBoxId, batch.status, batch.nodesCreated, batch.error,
          millisToDate(batch.createdAt), millisToDate(batch.completedAt), input.snapshotId ?? null],
      );
    }

    for (const box of input.topicBoxes) {
      await client.query(
        `INSERT INTO memory_topic_boxes
         (agent_id, external_id, message_ids, status, topic, events, keywords,
          client_created_at, client_sealed_at, sync_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (agent_id, external_id) DO UPDATE SET
          message_ids=EXCLUDED.message_ids, status=EXCLUDED.status, topic=EXCLUDED.topic,
          events=EXCLUDED.events, keywords=EXCLUDED.keywords,
          client_created_at=EXCLUDED.client_created_at,
          client_sealed_at=EXCLUDED.client_sealed_at,
          sync_snapshot_id=COALESCE(EXCLUDED.sync_snapshot_id, memory_topic_boxes.sync_snapshot_id),
          updated_at=now()`,
        [agentId, box.id, box.messageIds, box.status, box.topic, box.events, box.keywords,
          millisToDate(box.createdAt), millisToDate(box.sealedAt), input.snapshotId ?? null],
      );
    }

    const deletionTargets: Array<[string, string, string[]]> = [
      ['memory_event_boxes', 'external_id', input.deletions.eventBoxIds],
      ['memory_room_plates', 'external_id', input.deletions.roomPlateIds],
      ['memory_links', 'external_id', input.deletions.linkIds],
      ['memory_anticipations', 'external_id', input.deletions.anticipationIds],
      ['memory_digest_reports', 'external_id', input.deletions.digestReportIds],
      ['memory_vectors', 'memory_external_id', input.deletions.vectorMemoryIds],
      ['memory_batches', 'external_id', input.deletions.batchIds],
      ['memory_topic_boxes', 'external_id', input.deletions.topicBoxIds],
    ];
    const deleted: Record<string, number> = {};
    for (const [table, column, ids] of deletionTargets) {
      if (ids.length === 0) continue;
      const result = await client.query(
        `DELETE FROM ${table} WHERE agent_id=$1 AND ${column}=ANY($2::text[])`,
        [agentId, ids],
      );
      deleted[table] = result.rowCount ?? 0;
    }

    await client.query(
      `INSERT INTO memory_palace_sync_runs
       (client_id, agent_id, event_box_count, room_plate_count, link_count,
        anticipation_count, digest_report_count, vector_count, batch_count, topic_box_count, snapshot_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.clientId, agentId, input.eventBoxes.length, input.roomPlates.length,
        input.links.length, input.anticipations.length, input.digestReports.length, input.vectors.length,
        input.batches.length, input.topicBoxes.length, input.snapshotId ?? null],
    );
    await client.query('COMMIT');
    return {
      eventBoxes: input.eventBoxes.length,
      roomPlates: input.roomPlates.length,
      links: input.links.length,
      anticipations: input.anticipations.length,
      digestReports: input.digestReports.length,
      vectors: input.vectors.length,
      batches: input.batches.length,
      topicBoxes: input.topicBoxes.length,
      deleted,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileMemoryPalace(input: MemoryPalaceReconcileInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const agentId = await resolveAgentId(client, input.characterId);
    if (!agentId) throw new Error('memory_palace_character_not_synced');

    const targets = [
      'memory_event_boxes',
      'memory_room_plates',
      'memory_links',
      'memory_anticipations',
      'memory_digest_reports',
      'memory_vectors',
      'memory_batches',
      'memory_topic_boxes',
    ];
    const deleted: Record<string, number> = {};
    for (const table of targets) {
      const result = await client.query(
        `DELETE FROM ${table} WHERE agent_id=$1 AND sync_snapshot_id IS DISTINCT FROM $2`,
        [agentId, input.snapshotId],
      );
      deleted[table] = result.rowCount ?? 0;
    }
    const memoryResult = await client.query(
      `DELETE FROM memory_items
       WHERE agent_id=$1 AND external_id IS NOT NULL
         AND metadata->>'source'='frontend_sync'
         AND frontend_sync_snapshot_id IS DISTINCT FROM $2`,
      [agentId, input.snapshotId],
    );
    deleted.memory_items = memoryResult.rowCount ?? 0;

    await client.query('COMMIT');
    return { deleted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const paramsSchema = z.object({ characterId: z.string().min(1).max(200) });

export async function deleteAllMemoryPalaceData(client: PoolClient): Promise<Record<string, number>> {
  const agents = await client.query<{ id: string }>(
    'SELECT id FROM characters WHERE owner_user_id=$1',
    [DEFAULT_USER_ID],
  );
  const agentIds = agents.rows.map((row) => row.id);
  if (agentIds.length === 0) return {};
  const targets = [
    'memory_event_boxes',
    'memory_room_plates',
    'memory_links',
    'memory_anticipations',
    'memory_digest_reports',
    'memory_vectors',
    'memory_batches',
    'memory_topic_boxes',
    'memory_items',
  ];
  const deleted: Record<string, number> = {};
  for (const table of targets) {
    const result = await client.query(
      'DELETE FROM ' + table + ' WHERE agent_id=ANY($1::uuid[])',
      [agentIds],
    );
    deleted[table] = result.rowCount ?? 0;
  }
  return deleted;
}

export async function registerMemoryPalaceRoutes(app: FastifyInstance): Promise<void> {
  app.delete('/v1/memory-palace', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await deleteAllMemoryPalaceData(client);
      await client.query('COMMIT');
      return { data: { deleted } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/v1/memory-palace/sync', async (request, reply) => {
    const input = memoryPalaceSyncSchema.parse(request.body);
    try {
      return { data: await syncMemoryPalace(input) };
    } catch (error) {
      if (error instanceof Error && error.message === 'memory_palace_character_not_synced') {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/v1/memory-palace/reconcile', async (request, reply) => {
    const input = memoryPalaceReconcileSchema.parse(request.body);
    try {
      return { data: await reconcileMemoryPalace(input) };
    } catch (error) {
      if (error instanceof Error && error.message === 'memory_palace_character_not_synced') {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/v1/memory-palace/:characterId/stats', async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const agentResult = await pool.query<{ id: string }>(
      'SELECT id FROM characters WHERE owner_user_id=$1 AND external_id=$2 LIMIT 1',
      [DEFAULT_USER_ID, params.characterId],
    );
    const agentId = agentResult.rows[0]?.id;
    if (!agentId) return reply.code(404).send({ error: 'character_not_found' });
    const result = await pool.query<{
      nodes: string; event_boxes: string; room_plates: string; links: string;
      anticipations: string; digest_reports: string; vectors: string;
      batches: string; topic_boxes: string;
    }>(
      `SELECT
        (SELECT count(*) FROM memory_items
          WHERE agent_id=$1 AND external_id IS NOT NULL AND metadata->>'source'='frontend_sync') AS nodes,
        (SELECT count(*) FROM memory_event_boxes WHERE agent_id=$1) AS event_boxes,
        (SELECT count(*) FROM memory_room_plates WHERE agent_id=$1) AS room_plates,
        (SELECT count(*) FROM memory_links WHERE agent_id=$1) AS links,
        (SELECT count(*) FROM memory_anticipations WHERE agent_id=$1) AS anticipations,
        (SELECT count(*) FROM memory_digest_reports WHERE agent_id=$1) AS digest_reports,
        (SELECT count(*) FROM memory_vectors WHERE agent_id=$1) AS vectors,
        (SELECT count(*) FROM memory_batches WHERE agent_id=$1) AS batches,
        (SELECT count(*) FROM memory_topic_boxes WHERE agent_id=$1) AS topic_boxes`,
      [agentId],
    );
    const counts = result.rows[0];
    return { data: Object.fromEntries(Object.entries(counts || {}).map(([key, value]) => [key, Number(value)])) };
  });
}
