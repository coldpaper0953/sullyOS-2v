import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import {
  createChatCompletion,
  getModelStatus,
  ModelConfigurationError,
  ModelRequestError,
  type ModelMessage,
} from './modelClient.js';
import { buildAgentContextMessages } from './contextBuilder.js';
import {
  appendRuntimeInstruction,
  extractWakeReservation,
  wakeSchedulingInstruction,
} from './wakeScheduling.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

const promptMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.unknown(),
}).passthrough();

const chatTurnSchema = z.object({
  requestId: z.string().min(1).max(200),
  characterId: z.string().min(1).max(200),
  contextMode: z.enum(['frontend_snapshot', 'server_native']).default('frontend_snapshot'),
  promptMessages: z.array(promptMessageSchema).min(1).max(1_000).optional(),
  userMessage: z.string().max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
}).superRefine((value, context) => {
  if (value.contextMode === 'frontend_snapshot' && !value.promptMessages?.length) {
    context.addIssue({ code: 'custom', path: ['promptMessages'], message: 'frontend_snapshot requires promptMessages' });
  }
});

interface CharacterConversationRow {
  agent_id: string;
  conversation_id: string;
  context_version: string;
  timezone: string;
}

interface ExistingAssistantRow {
  id: string;
  sequence_id: string;
  content: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

function completionFromStoredEvent(event: ExistingAssistantRow): Record<string, unknown> {
  const usage = event.metadata?.usage;
  return {
    id: `stored-${event.id}`,
    object: 'chat.completion',
    created: Math.floor(event.occurred_at.getTime() / 1_000),
    model: event.metadata?.model ?? config.MODEL_NAME,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: event.content ?? '' } }],
    ...(usage && typeof usage === 'object' ? { usage } : {}),
  };
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/model/status', async () => ({ data: await getModelStatus() }));

  app.post('/v1/chat/turn', async (request, reply) => {
    const input = chatTurnSchema.parse(request.body);
    const idempotencyKey = `chat:${input.characterId}:${input.requestId}:assistant`;

    const targetResult = await pool.query<CharacterConversationRow>(
      `SELECT
         a.id AS agent_id,
         c.id AS conversation_id,
         s.context_version,
         a.timezone
       FROM characters a
       JOIN conversations c ON c.agent_id = a.id
       JOIN agent_state s ON s.agent_id = a.id
       WHERE a.owner_user_id = $1
         AND a.external_id = $2
         AND c.external_id = CONCAT('private:', $2)
       LIMIT 1`,
      [DEFAULT_USER_ID, input.characterId],
    );
    const target = targetResult.rows[0];
    if (!target) {
      return reply.code(409).send({
        error: 'context_not_synced',
        message: '请先调用 /v1/context/sync 同步这个角色的上下文。',
      });
    }

    const existingResult = await pool.query<ExistingAssistantRow>(
      `SELECT id, sequence_id, content, metadata, occurred_at
       FROM conversation_events
       WHERE idempotency_key = $1
       LIMIT 1`,
      [idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      return {
        data: completionFromStoredEvent(existing),
        event: existing,
        reused: true,
      };
    }

    try {
      const nativeContext = input.contextMode === 'server_native'
        ? await buildAgentContextMessages({
          characterId: input.characterId,
          userMessage: input.userMessage,
          purpose: 'chat',
        })
        : null;
      if (input.contextMode === 'server_native' && !nativeContext) {
        return reply.code(409).send({ error: 'context_not_synced', message: '服务端找不到该角色的上下文。' });
      }
      const modelMessages = appendRuntimeInstruction(
        nativeContext?.messages ?? input.promptMessages as ModelMessage[],
        wakeSchedulingInstruction(new Date(), target.timezone),
      );
      const completion = await createChatCompletion({
        messages: modelMessages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
      const choices = completion.choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message = first && typeof first === 'object'
        ? (first as Record<string, unknown>).message
        : undefined;
      const rawContent = message && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : '';
      const reservation = extractWakeReservation(typeof rawContent === 'string' ? rawContent : '');
      const content = reservation.content;
      const cleanCompletion = {
        ...completion,
        choices: Array.isArray(completion.choices)
          ? completion.choices.map((choice, index) => {
            if (index !== 0 || !choice || typeof choice !== 'object') return choice;
            const choiceRecord = choice as Record<string, unknown>;
            const choiceMessage = choiceRecord.message;
            return choiceMessage && typeof choiceMessage === 'object'
              ? { ...choiceRecord, message: { ...choiceMessage as Record<string, unknown>, content } }
              : choice;
          })
          : completion.choices,
      };
      const usage = completion.usage && typeof completion.usage === 'object'
        ? completion.usage
        : null;
      const backendRouting = completion.sully_backend && typeof completion.sully_backend === 'object'
        ? completion.sully_backend as Record<string, unknown>
        : null;

      const eventResult = await pool.query<ExistingAssistantRow>(
        `INSERT INTO conversation_events (
           conversation_id,
           actor_type,
           event_type,
           content,
           metadata,
           idempotency_key,
           occurred_at
         )
         VALUES ($1, 'assistant', 'assistant_message', $2, $3::jsonb, $4, now())
         ON CONFLICT (idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id, sequence_id, content, metadata, occurred_at`,
        [
          target.conversation_id,
          typeof content === 'string' ? content : '',
          JSON.stringify({
            source: 'backend_chat',
            requestId: input.requestId,
            model: backendRouting?.model ?? config.MODEL_NAME,
            ...(backendRouting ? { backendRouting } : {}),
            contextVersion: target.context_version,
            contextMode: input.contextMode,
            promptMessageCount: modelMessages.length,
            ...(nativeContext ? { contextDiagnostics: nativeContext.diagnostics } : {}),
            ...(reservation.dueAt ? { scheduledWakeAt: reservation.dueAt.toISOString() } : {}),
            ...(usage ? { usage } : {}),
          }),
          idempotencyKey,
        ],
      );
      const event = eventResult.rows[0];

      if (reservation.dueAt && event) {
        await pool.query(
          `INSERT INTO scheduled_wakes
           (agent_id, conversation_id, event_id, due_at, reason, created_by, dedupe_key, payload)
           VALUES ($1,$2,$3,$4,$5,'assistant',$6,$7::jsonb)
           ON CONFLICT (agent_id, dedupe_key) DO NOTHING`,
          [target.agent_id, target.conversation_id, event.id, reservation.dueAt,
            '角色在普通回复中预约继续一件事', `chat:${input.requestId}:wake`,
            JSON.stringify({ source: 'backend_chat', requestId: input.requestId })],
        );
      }

      await pool.query(
        `UPDATE agent_state
         SET last_agent_activity_at = now(),
             context_version = context_version + 1,
             updated_at = now()
         WHERE agent_id = $1`,
        [target.agent_id],
      );

      return {
        data: cleanCompletion,
        event,
        reused: false,
        ...(reservation.dueAt ? { scheduledWakeAt: reservation.dueAt.toISOString() } : {}),
      };
    } catch (error) {
      if (error instanceof ModelConfigurationError) {
        return reply.code(503).send({ error: 'model_not_configured', message: error.message });
      }
      if (error instanceof ModelRequestError) {
        return reply.code(error.statusCode).send({ error: 'model_request_failed', message: error.message });
      }
      throw error;
    }
  });
}
