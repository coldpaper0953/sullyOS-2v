import cors from '@fastify/cors';
import Fastify from 'fastify';
import { z } from 'zod';
import { registerAgentSettingsRoutes } from './agentSettings.js';
import { registerBackupRoutes } from './backupRoutes.js';
import { config } from './config.js';
import { registerChatRoutes } from './chat.js';
import { registerContextRoutes } from './contextSync.js';
import { closeDatabase, pool } from './db.js';
import { createEventSchema } from './eventTypes.js';
import { processDueHeartbeats } from './heartbeat.js';
import { registerMemoryPalaceRoutes } from './memoryPalaceSync.js';
import { registerDiaryRoutes } from './diaries.js';
import { ModelConfigurationError, ModelRequestError } from './modelClient.js';
import { registerModelProfileRoutes } from './modelProfiles.js';
import { registerPushRoutes } from './push.js';
import { registerPairingRoutes } from './pairing.js';
import { registerPhonePeekRoutes } from './phonePeek.js';
import { registerToolConnectionRoutes } from './toolConnections.js';

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });

await app.register(cors, {
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed'), false);
  },
});

app.addHook('onRequest', async (request, reply) => {
  const path = request.url.split('?', 1)[0];
  if (path === '/health' || path === '/v1/pair/exchange'
      || path === '/v1/phone/peek/pending' || path === '/v1/phone/peek/upload') return;

  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${config.APP_TOKEN}`) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/health', async () => {
  const result = await pool.query<{ now: Date }>('SELECT now() AS now');
  return {
    ok: true,
    service: 'sullyos-backend',
    databaseTime: result.rows[0]?.now.toISOString(),
  };
});

app.get('/v1/bootstrap', async () => {
  const result = await pool.query(
    `SELECT
       u.id AS user_id,
       u.display_name,
       a.id AS agent_id,
       a.name AS agent_name,
       a.timezone,
       a.heartbeat_interval_minutes,
       c.id AS conversation_id,
       c.title,
       s.last_heartbeat_at,
       s.next_wake_at
     FROM app_users u
     JOIN characters a ON a.owner_user_id = u.id
     JOIN conversations c ON c.agent_id = a.id
     JOIN agent_state s ON s.agent_id = a.id
     ORDER BY u.created_at
     LIMIT 1`,
  );

  return { data: result.rows[0] ?? null };
});

const listEventsQuerySchema = z.object({
  conversationId: z.uuid().optional(),
  afterSequence: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

app.get('/v1/events/cursor', async () => {
  const result = await pool.query<{ sequence_id: string }>(
    `SELECT COALESCE(MAX(e.sequence_id), 0)::text AS sequence_id
     FROM conversation_events e
     JOIN conversations c ON c.id = e.conversation_id
     JOIN characters a ON a.id = c.agent_id`,
  );

  return { data: { sequenceId: result.rows[0]?.sequence_id ?? '0' } };
});

app.get('/v1/events', async (request) => {
  const query = listEventsQuerySchema.parse(request.query);
  const result = await pool.query(
    `SELECT
       e.sequence_id,
       e.id,
       e.conversation_id,
       a.external_id AS character_id,
       a.name AS character_name,
       e.actor_type,
       e.event_type,
       e.content,
       e.metadata,
       e.occurred_at,
       e.created_at
     FROM conversation_events e
     JOIN conversations c ON c.id = e.conversation_id
     JOIN characters a ON a.id = c.agent_id
     WHERE e.sequence_id > $1
       AND e.deleted_at IS NULL
       AND ($2::uuid IS NULL OR e.conversation_id = $2)
     ORDER BY e.sequence_id ASC
     LIMIT $3`,
    [query.afterSequence, query.conversationId ?? null, query.limit],
  );

  return { data: result.rows };
});

app.post('/v1/events', async (request, reply) => {
  const input = createEventSchema.parse(request.body);
  const result = await pool.query(
    `INSERT INTO conversation_events (
       conversation_id,
       actor_type,
       event_type,
       content,
       metadata,
       idempotency_key,
       occurred_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [
      input.conversationId,
      input.actorType,
      input.eventType,
      input.content ?? null,
      JSON.stringify(input.metadata),
      input.idempotencyKey ?? null,
      input.occurredAt ?? null,
    ],
  );

  if (input.eventType === 'user_message') {
    await pool.query(
      `UPDATE agent_state s
       SET last_user_activity_at = $2,
           context_version = context_version + 1,
           updated_at = now()
       FROM conversations c
       WHERE c.id = $1 AND s.agent_id = c.agent_id`,
      [input.conversationId, input.occurredAt ?? new Date().toISOString()],
    );
  }

  return reply.code(201).send({ data: result.rows[0] });
});

const heartbeatRequestSchema = z.object({
  demoMessage: z.boolean().default(false),
});

app.post('/v1/heartbeats/run', async (request) => {
  const input = heartbeatRequestSchema.parse(request.body ?? {});
  const results = await processDueHeartbeats({ force: true, demoMode: input.demoMessage });
  return { data: results };
});

await registerContextRoutes(app);
await registerChatRoutes(app);
await registerModelProfileRoutes(app);
await registerMemoryPalaceRoutes(app);
await registerAgentSettingsRoutes(app);
await registerDiaryRoutes(app);
await registerPushRoutes(app);
await registerPairingRoutes(app);
await registerToolConnectionRoutes(app);
await registerPhonePeekRoutes(app);
await registerBackupRoutes(app);

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    void reply.code(400).send({ error: 'invalid_request', details: error.issues });
    return;
  }

  if (error instanceof ModelConfigurationError) {
    void reply.code(409).send({ error: 'model_not_configured', message: error.message });
    return;
  }

  if (error instanceof ModelRequestError) {
    app.log.warn({ error }, 'model request failed');
    void reply.code(error.statusCode).send({ error: 'model_unavailable', message: error.message });
    return;
  }

  app.log.error(error);
  void reply.code(500).send({ error: 'internal_error' });
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
