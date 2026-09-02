import { z } from 'zod';

const metadataSchema = z.record(z.string(), z.unknown());
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const characterContextSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(100_000).default(''),
  systemPrompt: z.string().max(200_000).default(''),
  worldview: z.string().max(100_000).nullable().optional(),
  writerPersona: z.string().max(100_000).nullable().optional(),
  legacyMemories: z
    .array(z.object({
      id: z.string().max(200),
      date: z.string().max(100),
      summary: z.string().max(20_000),
      mood: z.string().max(200).optional(),
    }))
    .max(5_000)
    .default([]),
  refinedMemories: z.record(z.string(), z.string().max(100_000)).default({}),
  metadata: metadataSchema.default({}),
  heartbeatEnabled: z.boolean().optional(),
  heartbeatIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  timezone: z.string().min(1).max(100).optional(),
  updatedAt: timestampSchema.optional(),
});

export const userContextSchema = z.object({
  name: z.string().min(1).max(200),
  bio: z.string().max(100_000).default(''),
});

export const syncedMessageSchema = z.object({
  id: timestampSchema,
  role: z.enum(['user', 'assistant', 'system']),
  type: z.string().min(1).max(100),
  content: z.string().max(200_000),
  timestamp: timestampSchema,
  metadata: metadataSchema.optional(),
  replyTo: z.object({
    id: timestampSchema,
    content: z.string().max(20_000),
    name: z.string().max(200),
  }).optional(),
});

export const memoryRoomSchema = z.enum([
  'living_room',
  'bedroom',
  'study',
  'user_room',
  'self_room',
  'attic',
  'windowsill',
]);

export const syncedMemorySchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(200_000),
  room: memoryRoomSchema,
  tags: z.array(z.string().max(200)).max(100).default([]),
  importance: z.number().int().min(1).max(10),
  mood: z.string().max(200).default(''),
  valence: z.number().min(-1).max(1).nullable().optional(),
  arousal: z.number().min(-1).max(1).nullable().optional(),
  embedded: z.boolean().default(false),
  createdAt: timestampSchema,
  lastAccessedAt: timestampSchema,
  accessCount: z.number().int().nonnegative().default(0),
  pinnedUntil: timestampSchema.nullable().optional(),
  sourceId: z.string().max(200).nullable().optional(),
  origin: z.enum(['extraction', 'digestion', 'system']).nullable().optional(),
  digestedAt: timestampSchema.nullable().optional(),
  eventBoxId: z.string().max(200).nullable().optional(),
  archived: z.boolean().default(false),
  isBoxSummary: z.boolean().default(false),
  metadata: metadataSchema.default({}),
  updatedAt: timestampSchema.optional(),
});

export const contextSyncSchema = z.object({
  clientId: z.string().min(1).max(200),
  snapshotId: z.string().min(1).max(200).optional(),
  clientName: z.string().max(200).optional(),
  user: userContextSchema,
  character: characterContextSchema,
  messages: z.array(syncedMessageSchema).max(1_000).default([]),
  memories: z.array(syncedMemorySchema).max(5_000).default([]),
  deletedMessageIds: z.array(timestampSchema).max(5_000).default([]),
  deletedEventIds: z.array(z.uuid()).max(5_000).default([]),
  deletedMemoryIds: z.array(z.string().min(1).max(200)).max(5_000).default([]),
});

export type ContextSyncInput = z.infer<typeof contextSyncSchema>;
export type SyncedMessage = z.infer<typeof syncedMessageSchema>;
export type SyncedMemory = z.infer<typeof syncedMemorySchema>;
