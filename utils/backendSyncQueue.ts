import { openDB } from './db';

const STORE = 'backend_sync_queue';

export type BackendMemoryEntityType =
    | 'chat_message'
    | 'backend_event'
    | 'memory_node'
    | 'memory_vector'
    | 'memory_link'
    | 'event_box'
    | 'room_plate'
    | 'anticipation'
    | 'digest_report'
    | 'memory_batch'
    | 'topic_box';

export interface BackendMemoryChange {
    key: string;
    charId: string;
    entityType: BackendMemoryEntityType;
    entityId: string;
    operation: 'upsert' | 'delete';
    payload?: unknown;
    updatedAt: number;
}

function changeKey(charId: string, entityType: BackendMemoryEntityType, entityId: string): string {
    return `${charId}:${entityType}:${entityId}`;
}

export async function enqueueBackendMemoryChanges(
    changes: Array<Omit<BackendMemoryChange, 'key' | 'updatedAt'>>,
): Promise<void> {
    if (changes.length === 0) return;
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE)) return;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const now = Date.now();
        for (const change of changes) {
            store.put({
                ...change,
                key: changeKey(change.charId, change.entityType, change.entityId),
                updatedAt: now,
            } satisfies BackendMemoryChange);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export function enqueueBackendMemoryChange(
    change: Omit<BackendMemoryChange, 'key' | 'updatedAt'>,
): Promise<void> {
    return enqueueBackendMemoryChanges([change]);
}

export function enqueueBackendChatMessageDeletes(
    charId: string,
    messages: Array<{ id: number; metadata?: { backendEventId?: unknown } }>,
): Promise<void> {
    return enqueueBackendMemoryChanges(messages.map(message => {
        const backendEventId = typeof message.metadata?.backendEventId === 'string'
            ? message.metadata.backendEventId
            : '';
        return {
            charId,
            entityType: backendEventId ? 'backend_event' as const : 'chat_message' as const,
            entityId: backendEventId || String(message.id),
            operation: 'delete' as const,
        };
    }));
}

export async function getBackendMemoryChanges(charId: string, limit = 2_000): Promise<BackendMemoryChange[]> {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE)) return [];
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).index('charId').getAll(IDBKeyRange.only(charId));
        request.onsuccess = () => resolve(
            (request.result as BackendMemoryChange[])
                .sort((left, right) => left.updatedAt - right.updatedAt)
                .slice(0, Math.max(1, limit)),
        );
        request.onerror = () => reject(request.error);
    });
}

/** Read specific queue entries without being blocked by older unrelated changes. */
export async function getBackendMemoryChangesByKeys(
    charId: string,
    keys: string[],
): Promise<BackendMemoryChange[]> {
    if (keys.length === 0) return [];
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE)) return [];
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const results: BackendMemoryChange[] = [];
        let remaining = keys.length;
        for (const key of keys) {
            const request = store.get(key);
            request.onsuccess = () => {
                const value = request.result as BackendMemoryChange | undefined;
                if (value?.charId === charId) results.push(value);
                remaining -= 1;
                if (remaining === 0) resolve(results);
            };
            request.onerror = () => reject(request.error);
        }
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function acknowledgeBackendMemoryChanges(
    acknowledged: Array<Pick<BackendMemoryChange, 'key' | 'updatedAt'>>,
): Promise<void> {
    if (acknowledged.length === 0) return;
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE)) return;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const item of acknowledged) {
            const request = store.get(item.key);
            request.onsuccess = () => {
                const current = request.result as BackendMemoryChange | undefined;
                if (current && current.updatedAt <= item.updatedAt) store.delete(item.key);
            };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** 全量快照成功后，只清除快照开始前已经存在的队列项，保留同步期间的新修改。 */
export async function acknowledgeBackendMemoryChangesThrough(
    charId: string,
    throughTimestamp: number,
): Promise<void> {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE)) return;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const request = tx.objectStore(STORE).index('charId').openCursor(IDBKeyRange.only(charId));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const value = cursor.value as BackendMemoryChange;
            if (value.updatedAt <= throughTimestamp) cursor.delete();
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
