import type { SyncedMemory, SyncedMessage } from './contextSchemas.js';

export type SyncedEventType = 'user_message' | 'assistant_message' | 'system_event';

export function messageRoleToEventType(role: SyncedMessage['role']): SyncedEventType {
  if (role === 'user') return 'user_message';
  if (role === 'assistant') return 'assistant_message';
  return 'system_event';
}

export function memoryToKind(memory: Pick<SyncedMemory, 'isBoxSummary'>): 'episode' | 'summary' {
  return memory.isBoxSummary ? 'summary' : 'episode';
}

export function millisToDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' ? new Date(value) : null;
}
