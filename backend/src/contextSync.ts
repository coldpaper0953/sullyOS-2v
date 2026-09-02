import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { contextSyncSchema, type ContextSyncInput, type SyncedMemory, type SyncedMessage } from './contextSchemas.js';
import { memoryToKind, messageRoleToEventType, millisToDate } from './contextMapping.js';
import { pool } from './db.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

interface SyncedContextResult {
  agentId: string;
  conversationId: string;
  contextVersion: string;
  syncedMessages: number;
  syncedMemories: number;
  deletedMessages: number;
  deletedMemories: number;
}

async function upsertMessage(
  client: PoolClient,
  input: ContextSyncInput,
  conversationId: string,
  message: SyncedMessage,
): Promise<void> {
  const metadata = {
    ...(message.metadata ?? {}),
    source: 'frontend_sync',
    sullyosMessageType: message.type,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };

  await client.query(
    `INSERT INTO conversation_events (
       conversation_id,
       actor_type,
       event_type,
       content,
       metadata,
       occurred_at,
       source_message_id,
       source_device_id,
       source_message_type
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (conversation_id, source_message_id)
       WHERE source_message_id IS NOT NULL
     DO UPDATE SET
       actor_type = EXCLUDED.actor_type,
       event_type = EXCLUDED.event_type,
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata,
       occurred_at = EXCLUDED.occurred_at,
       source_device_id = EXCLUDED.source_device_id,
       source_message_type = EXCLUDED.source_message_type,
       updated_at = now(),
       deleted_at = NULL`,
    [
      conversationId,
      message.role,
      messageRoleToEventType(message.role),
      message.content,
      JSON.stringify(metadata),
      millisToDate(message.timestamp),
      message.id,
      input.clientId,
      message.type,
    ],
  );
}

async function upsertMemory(
  client: PoolClient,
  agentId: string,
  memory: SyncedMemory,
  snapshotId?: string,
): Promise<void> {
  const metadata = {
    ...memory.metadata,
    source: 'frontend_sync',
    digestedAt: memory.digestedAt ?? null,
  };

  await client.query(
    `INSERT INTO memory_items (
       agent_id,
       external_id,
       kind,
       content,
       importance,
       metadata,
       created_at,
       updated_at,
       archived_at,
       room,
       tags,
       mood,
       valence,
       arousal,
       embedded,
       last_accessed_at,
       access_count,
       source_memory_id,
       origin,
       event_box_id,
       archived,
       is_box_summary,
       client_updated_at,
       frontend_sync_snapshot_id
     )
     VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7, now(), $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
     )
     ON CONFLICT (agent_id, external_id)
       WHERE external_id IS NOT NULL
     DO UPDATE SET
       kind = EXCLUDED.kind,
       content = EXCLUDED.content,
       importance = EXCLUDED.importance,
       metadata = EXCLUDED.metadata,
       archived_at = EXCLUDED.archived_at,
       room = EXCLUDED.room,
       tags = EXCLUDED.tags,
       mood = EXCLUDED.mood,
       valence = EXCLUDED.valence,
       arousal = EXCLUDED.arousal,
       embedded = EXCLUDED.embedded,
       last_accessed_at = EXCLUDED.last_accessed_at,
       access_count = EXCLUDED.access_count,
       source_memory_id = EXCLUDED.source_memory_id,
       origin = EXCLUDED.origin,
       event_box_id = EXCLUDED.event_box_id,
       archived = EXCLUDED.archived,
       is_box_summary = EXCLUDED.is_box_summary,
       client_updated_at = EXCLUDED.client_updated_at,
       frontend_sync_snapshot_id = COALESCE(
         EXCLUDED.frontend_sync_snapshot_id,
         memory_items.frontend_sync_snapshot_id
       ),
       updated_at = now()`,
    [
      agentId,
      memory.id,
      memoryToKind(memory),
      memory.content,
      memory.importance,
      JSON.stringify(metadata),
      millisToDate(memory.createdAt),
      memory.archived ? new Date() : null,
      memory.room,
      memory.tags,
      memory.mood,
      memory.valence ?? null,
      memory.arousal ?? null,
      memory.embedded,
      millisToDate(memory.lastAccessedAt),
      memory.accessCount,
      memory.sourceId ?? null,
      memory.origin ?? null,
      memory.eventBoxId ?? null,
      memory.archived,
      memory.isBoxSummary,
      millisToDate(memory.updatedAt ?? memory.lastAccessedAt),
      snapshotId ?? null,
    ],
  );
}

export async function syncContext(input: ContextSyncInput): Promise<SyncedContextResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE app_users
       SET display_name = $2, bio = $3, updated_at = now()
       WHERE id = $1`,
      [DEFAULT_USER_ID, input.user.name, input.user.bio],
    );

    await client.query(
      `INSERT INTO sync_clients (client_id, owner_user_id, client_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         last_seen_at = now()`,
      [input.clientId, DEFAULT_USER_ID, input.clientName ?? null],
    );

    const character = input.character;
    const agentResult = await client.query<{ id: string }>(
      `INSERT INTO characters (
         owner_user_id,
         external_id,
         name,
         description,
         system_prompt,
         worldview,
         writer_persona,
         legacy_memories,
         refined_memories,
         profile_metadata,
         heartbeat_enabled,
         heartbeat_interval_minutes,
         timezone,
         client_updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
         COALESCE($11, false), COALESCE($12, 5), COALESCE($13, 'UTC'), $14
       )
       ON CONFLICT (owner_user_id, external_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         system_prompt = EXCLUDED.system_prompt,
         worldview = EXCLUDED.worldview,
         writer_persona = EXCLUDED.writer_persona,
         legacy_memories = EXCLUDED.legacy_memories,
         refined_memories = EXCLUDED.refined_memories,
         profile_metadata = EXCLUDED.profile_metadata,
         heartbeat_enabled = COALESCE($11, characters.heartbeat_enabled),
         heartbeat_interval_minutes = COALESCE($12, characters.heartbeat_interval_minutes),
         timezone = COALESCE($13, characters.timezone),
         client_updated_at = EXCLUDED.client_updated_at,
         updated_at = now()
       RETURNING id`,
      [
        DEFAULT_USER_ID,
        character.id,
        character.name,
        character.description,
        character.systemPrompt,
        character.worldview ?? null,
        character.writerPersona ?? null,
        JSON.stringify(character.legacyMemories),
        JSON.stringify(character.refinedMemories),
        JSON.stringify(character.metadata),
        character.heartbeatEnabled ?? null,
        character.heartbeatIntervalMinutes ?? null,
        character.timezone ?? null,
        millisToDate(character.updatedAt),
      ],
    );
    const agentId = agentResult.rows[0]?.id;
    if (!agentId) throw new Error('Failed to create or update agent context.');

    const conversationResult = await client.query<{ id: string }>(
      `INSERT INTO conversations (owner_user_id, agent_id, external_id, title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_user_id, external_id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         title = EXCLUDED.title,
         updated_at = now()
       RETURNING id`,
      [DEFAULT_USER_ID, agentId, `private:${character.id}`, `${character.name} · 私聊`],
    );
    const conversationId = conversationResult.rows[0]?.id;
    if (!conversationId) throw new Error('Failed to create or update conversation.');

    await client.query(
      `INSERT INTO agent_state (agent_id, next_wake_at)
       VALUES ($1, now())
       ON CONFLICT (agent_id) DO NOTHING`,
      [agentId],
    );

    for (const message of input.messages) {
      await upsertMessage(client, input, conversationId, message);
    }

    for (const memory of input.memories) {
      await upsertMemory(client, agentId, memory, input.snapshotId);
    }

    let deletedMessages = 0;
    if (input.deletedMessageIds.length > 0 || input.deletedEventIds.length > 0) {
      const result = await client.query(
        `UPDATE conversation_events
         SET deleted_at = now(), updated_at = now()
         WHERE conversation_id = $1
           AND (
             source_message_id = ANY($2::bigint[])
             OR id = ANY($3::uuid[])
           )
           AND deleted_at IS NULL`,
        [conversationId, input.deletedMessageIds, input.deletedEventIds],
      );
      deletedMessages = result.rowCount ?? 0;
    }

    let deletedMemories = 0;
    if (input.deletedMemoryIds.length > 0) {
      const result = await client.query(
        `UPDATE memory_items
         SET archived = true, archived_at = now(), updated_at = now()
         WHERE agent_id = $1
           AND external_id = ANY($2::text[])
           AND archived = false`,
        [agentId, input.deletedMemoryIds],
      );
      deletedMemories = result.rowCount ?? 0;
    }

    const latestUserTimestamp = input.messages
      .filter((message) => message.role === 'user')
      .reduce<number | null>((latest, message) => Math.max(latest ?? 0, message.timestamp), null);
    const latestAgentTimestamp = input.messages
      .filter((message) => message.role === 'assistant')
      .reduce<number | null>((latest, message) => Math.max(latest ?? 0, message.timestamp), null);

    const stateResult = await client.query<{ context_version: string }>(
      `UPDATE agent_state
       SET last_user_activity_at = CASE
             WHEN $2::timestamptz IS NULL THEN last_user_activity_at
             ELSE GREATEST(COALESCE(last_user_activity_at, $2::timestamptz), $2::timestamptz)
           END,
           last_agent_activity_at = CASE
             WHEN $3::timestamptz IS NULL THEN last_agent_activity_at
             ELSE GREATEST(COALESCE(last_agent_activity_at, $3::timestamptz), $3::timestamptz)
           END,
           context_version = context_version + 1,
           updated_at = now()
       WHERE agent_id = $1
       RETURNING context_version`,
      [agentId, millisToDate(latestUserTimestamp), millisToDate(latestAgentTimestamp)],
    );
    const contextVersion = stateResult.rows[0]?.context_version ?? '0';

    await client.query(
      `INSERT INTO sync_runs (
         client_id,
         agent_id,
         message_count,
         memory_count,
         deleted_message_count,
         deleted_memory_count,
         context_version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.clientId,
        agentId,
        input.messages.length,
        input.memories.length,
        deletedMessages,
        deletedMemories,
        contextVersion,
      ],
    );

    await client.query('COMMIT');
    return {
      agentId,
      conversationId,
      contextVersion,
      syncedMessages: input.messages.length,
      syncedMemories: input.memories.length,
      deletedMessages,
      deletedMemories,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const contextParamsSchema = z.object({
  characterId: z.string().min(1).max(200),
});

const contextQuerySchema = z.object({
  messageLimit: z.coerce.number().int().min(1).max(500).default(50),
  memoryLimit: z.coerce.number().int().min(1).max(1_000).default(100),
});

export async function registerContextRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/context/sync', async (request) => {
    const input = contextSyncSchema.parse(request.body);
    return { data: await syncContext(input) };
  });

  app.get('/v1/context/:characterId', async (request, reply) => {
    const params = contextParamsSchema.parse(request.params);
    const query = contextQuerySchema.parse(request.query);
    const agentResult = await pool.query(
      `SELECT
         a.id,
         a.external_id,
         a.name,
         a.description,
         a.system_prompt,
         a.worldview,
         a.writer_persona,
         a.legacy_memories,
         a.refined_memories,
         a.profile_metadata,
         a.heartbeat_enabled,
         a.heartbeat_interval_minutes,
         u.display_name AS user_name,
         u.bio AS user_bio,
         c.id AS conversation_id,
         s.context_version,
         s.last_user_activity_at,
         s.last_agent_activity_at,
         s.last_heartbeat_at,
         s.next_wake_at
       FROM characters a
       JOIN app_users u ON u.id = a.owner_user_id
       JOIN conversations c ON c.agent_id = a.id
       JOIN agent_state s ON s.agent_id = a.id
       WHERE a.owner_user_id = $1 AND a.external_id = $2
       LIMIT 1`,
      [DEFAULT_USER_ID, params.characterId],
    );
    const agent = agentResult.rows[0] as { id?: string; conversation_id?: string } | undefined;
    if (!agent?.id || !agent.conversation_id) {
      return reply.code(404).send({ error: 'context_not_found' });
    }

    const [messages, memories] = await Promise.all([
      pool.query(
        `SELECT
           sequence_id,
           id,
           actor_type,
           event_type,
           content,
           metadata,
           source_message_id,
           source_message_type,
           occurred_at,
           updated_at
         FROM conversation_events
         WHERE conversation_id = $1 AND deleted_at IS NULL
         ORDER BY occurred_at DESC, sequence_id DESC
         LIMIT $2`,
        [agent.conversation_id, query.messageLimit],
      ),
      pool.query(
        `SELECT
           id,
           external_id,
           kind,
           room,
           content,
           tags,
           importance,
           mood,
           valence,
           arousal,
           origin,
           event_box_id,
           is_box_summary,
           metadata,
           created_at,
           last_accessed_at,
           access_count
         FROM memory_items
         WHERE agent_id = $1 AND archived = false AND archived_at IS NULL
         ORDER BY importance DESC, last_accessed_at DESC NULLS LAST
         LIMIT $2`,
        [agent.id, query.memoryLimit],
      ),
    ]);

    return {
      data: {
        agent,
        messages: messages.rows.reverse(),
        memories: memories.rows,
      },
    };
  });

  app.delete('/v1/context/:characterId', async (request, reply) => {
    const params = contextParamsSchema.parse(request.params);
    const result = await pool.query<{ id: string }>(
      'DELETE FROM characters WHERE owner_user_id=$1 AND external_id=$2 RETURNING id',
      [DEFAULT_USER_ID, params.characterId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'context_not_found' });
    return { data: { characterId: params.characterId, deleted: true } };
  });
}
