import { z } from 'zod';
import { memoryRoomSchema } from './contextSchemas.js';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(200);
const shortText = z.string().max(500);

export const eventBoxSchema = z.object({
  id,
  name: z.string().max(2_000),
  tags: z.array(z.string().max(200)).max(200).default([]),
  summaryNodeId: id.nullable(),
  liveMemoryIds: z.array(id).max(10_000).default([]),
  archivedMemoryIds: z.array(id).max(50_000).default([]),
  compressionCount: z.number().int().nonnegative().default(0),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastCompressedAt: timestamp.nullable(),
  sealed: z.boolean().default(false),
  predecessorBoxId: id.nullable().optional(),
});

const plateEntrySchema = z.object({
  id,
  text: z.string().min(1).max(10_000),
  firstLearnedAt: timestamp,
  updatedAt: timestamp,
  sourceCount: z.number().int().nonnegative(),
  tag: z.string().max(200).optional(),
});

export const roomPlateSchema = z.object({
  id,
  room: z.enum(['user_room', 'self_room', 'bedroom', 'study']),
  entries: z.array(plateEntrySchema).max(500),
  updatedAt: timestamp,
  version: z.number().int().nonnegative(),
});

export const memoryLinkSchema = z.object({
  id,
  sourceId: id,
  targetId: id,
  type: z.enum(['temporal', 'emotional', 'causal', 'person', 'metaphor']),
  strength: z.number().min(0).max(1),
});

export const anticipationSchema = z.object({
  id,
  content: z.string().min(1).max(200_000),
  status: z.enum(['active', 'anchor', 'fulfilled', 'disappointed']),
  createdAt: timestamp,
  anchoredAt: timestamp.nullable(),
  resolvedAt: timestamp.nullable(),
});

const reportSectionSchema = z.object({
  label: z.string().max(500),
  items: z.array(z.string().max(20_000)).max(1_000),
});

export const digestReportSchema = z.object({
  id,
  createdAt: timestamp,
  trigger: z.enum(['auto', 'manual']),
  examined: z.array(reportSectionSchema).max(1_000),
  outcomes: z.array(reportSectionSchema).max(1_000),
  plateSubmissions: z.array(reportSectionSchema).max(1_000),
  plateUpdated: z.array(memoryRoomSchema).max(100),
});

export const memoryVectorSchema = z.object({
  memoryId: id,
  dimensions: z.number().int().min(1).max(65_536),
  model: shortText.nullable().optional(),
  vectorBase64: z.string().min(1).max(2_000_000),
});

export const memoryBatchSchema = z.object({
  id,
  eventBoxId: id.nullable(),
  status: z.enum(['pending', 'processing', 'done', 'error']),
  nodesCreated: z.number().int().nonnegative(),
  error: z.string().max(20_000).nullable(),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
});

export const memoryTopicBoxSchema = z.object({
  id,
  messageIds: z.array(timestamp).max(100_000),
  status: z.enum(['open', 'sealed']),
  topic: z.string().max(20_000),
  events: z.array(z.string().max(20_000)).max(10_000),
  keywords: z.array(z.string().max(500)).max(10_000),
  createdAt: timestamp,
  sealedAt: timestamp.nullable(),
});

export const memoryPalaceSyncSchema = z.object({
  clientId: id,
  characterId: id,
  snapshotId: id.optional(),
  eventBoxes: z.array(eventBoxSchema).max(500).default([]),
  roomPlates: z.array(roomPlateSchema).max(100).default([]),
  links: z.array(memoryLinkSchema).max(2_000).default([]),
  anticipations: z.array(anticipationSchema).max(1_000).default([]),
  digestReports: z.array(digestReportSchema).max(200).default([]),
  vectors: z.array(memoryVectorSchema).max(200).default([]),
  batches: z.array(memoryBatchSchema).max(2_000).default([]),
  topicBoxes: z.array(memoryTopicBoxSchema).max(2_000).default([]),
  deletions: z.object({
    eventBoxIds: z.array(id).max(5_000).default([]),
    roomPlateIds: z.array(id).max(5_000).default([]),
    linkIds: z.array(id).max(5_000).default([]),
    anticipationIds: z.array(id).max(5_000).default([]),
    digestReportIds: z.array(id).max(5_000).default([]),
    vectorMemoryIds: z.array(id).max(5_000).default([]),
    batchIds: z.array(id).max(5_000).default([]),
    topicBoxIds: z.array(id).max(5_000).default([]),
  }).default({
    eventBoxIds: [],
    roomPlateIds: [],
    linkIds: [],
    anticipationIds: [],
    digestReportIds: [],
    vectorMemoryIds: [],
    batchIds: [],
    topicBoxIds: [],
  }),
});

export const memoryPalaceReconcileSchema = z.object({
  characterId: id,
  snapshotId: id,
});

export type MemoryPalaceSyncInput = z.infer<typeof memoryPalaceSyncSchema>;
export type MemoryPalaceReconcileInput = z.infer<typeof memoryPalaceReconcileSchema>;
