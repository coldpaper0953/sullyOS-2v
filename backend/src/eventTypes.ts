import { z } from 'zod';

export const actorTypeSchema = z.enum(['user', 'assistant', 'system', 'tool']);

export const eventTypeSchema = z.enum([
  'user_message',
  'assistant_message',
  'proactive_message',
  'diary_entry',
  'diary_comment',
  'autonomous_activity',
  'mcp_activity',
  'activity_summary',
  'tool_activity',
  'platform_share',
  'memory_update',
  'scheduled_wake',
  'system_event',
]);

export const createEventSchema = z.object({
  conversationId: z.uuid(),
  actorType: actorTypeSchema,
  eventType: eventTypeSchema,
  content: z.string().max(100_000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(200).nullable().optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
