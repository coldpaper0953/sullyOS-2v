import type { BackendConversationEventRecord, CharacterProfile, DiaryEntry } from '../types';
import { DB } from './db';

const PAPER_NAMES: Record<string, string> = {
    plain: '白纸',
    grid: '网格',
    dot: '点阵',
    lined: '横线',
    dark: '夜空',
    pink: '粉色',
};

export function buildDiaryCardPayload(
    entry: DiaryEntry,
    char: Pick<CharacterProfile, 'name' | 'avatar'>,
    userName: string,
) {
    const comments = (entry.comments || []).slice(-3).map(comment => ({
        id: comment.id,
        author: comment.author,
        content: comment.content,
        createdAt: comment.createdAt,
    }));
    const primaryAuthor = entry.primaryAuthor === 'character' ? 'character' : 'user';
    const mainText = primaryAuthor === 'character'
        ? entry.charPage?.text || ''
        : entry.userPage.text || '';
    return {
        type: 'diary_card',
        version: 2,
        entryId: entry.id,
        backendDiaryId: entry.backendDiaryId || '',
        primaryAuthor,
        title: entry.title || '',
        date: entry.date,
        charName: char.name,
        charAvatar: char.avatar || '',
        userName,
        mainText,
        authorName: primaryAuthor === 'character' ? char.name : userName,
        userText: entry.userPage.text,
        charText: entry.charPage?.text || '',
        userPaperStyle: entry.userPage.paperStyle,
        userPaperName: PAPER_NAMES[entry.userPage.paperStyle] || '白纸',
        charPaperStyle: entry.charPage?.paperStyle || '',
        charPaperName: entry.charPage ? (PAPER_NAMES[entry.charPage.paperStyle] || '白纸') : '',
        userStickerCount: entry.userPage.stickers?.length || 0,
        charStickerCount: entry.charPage?.stickers?.length || 0,
        commentCount: entry.comments?.length || 0,
        latestComments: comments,
        origin: entry.origin || 'independent',
    };
}

const diaryCardWrites = new Map<string, Promise<number>>();

function diaryCardKey(entry: Pick<DiaryEntry, 'charId' | 'id' | 'backendDiaryId'>): string {
    return `${entry.charId}:${entry.backendDiaryId ? `backend:${entry.backendDiaryId}` : `local:${entry.id}`}`;
}

function readDiaryCardPayload(message: { content: string; metadata?: any }): Record<string, unknown> | null {
    const fromMetadata = message.metadata?.scoreCard;
    if (fromMetadata && typeof fromMetadata === 'object') return fromMetadata as Record<string, unknown>;
    try {
        const parsed = JSON.parse(message.content);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function isSameDiaryCard(payload: Record<string, unknown> | null, entry: DiaryEntry): boolean {
    if (!payload || payload.type !== 'diary_card') return false;
    const backendDiaryId = typeof payload.backendDiaryId === 'string' ? payload.backendDiaryId : '';
    const entryId = typeof payload.entryId === 'string' ? payload.entryId : '';
    return Boolean(entry.backendDiaryId && backendDiaryId === entry.backendDiaryId)
        || Boolean(entryId && entryId === entry.id);
}

/**
 * Creates or updates the single chat card belonging to a diary.
 *
 * The journal screen and backend-event poller can observe the same diary at the
 * same time. The per-diary promise lock prevents both paths from inserting, and
 * the database scan also repairs duplicates created by older versions.
 */
export async function upsertDiaryCardMessage(
    entry: DiaryEntry,
    char: Pick<CharacterProfile, 'name' | 'avatar'>,
    userName: string,
    source = 'journal',
): Promise<DiaryEntry> {
    const mainText = entry.primaryAuthor === 'character' ? entry.charPage?.text : entry.userPage.text;
    if (!mainText?.trim()) return entry;

    const key = diaryCardKey(entry);
    const inFlight = diaryCardWrites.get(key);
    if (inFlight) {
        const messageId = await inFlight;
        return { ...entry, chatCardMessageId: messageId };
    }

    const write = (async () => {
        const cardData = buildDiaryCardPayload(entry, char, userName || '我');
        const messages = await DB.getMessagesByCharId(entry.charId, true);
        const matches = messages
            .filter(message => message.type === 'score_card' && isSameDiaryCard(readDiaryCardPayload(message), entry))
            .sort((left, right) => left.id - right.id);

        let messageId = matches[0]?.id;
        if (messageId) {
            await DB.updateMessage(messageId, JSON.stringify(cardData));
            await DB.updateMessageMetadata(messageId, previous => ({
                ...(previous || {}),
                scoreCard: cardData,
                source,
                diaryCardKey: key,
            }));
            const duplicateIds = matches.slice(1).map(message => message.id);
            if (duplicateIds.length > 0) await DB.deleteMessages(duplicateIds);
        } else {
            messageId = await DB.saveMessage({
                charId: entry.charId,
                role: 'system',
                type: 'score_card',
                content: JSON.stringify(cardData),
                timestamp: entry.timestamp,
                metadata: { scoreCard: cardData, source, diaryCardKey: key },
            });
        }
        return messageId;
    })();

    diaryCardWrites.set(key, write);
    try {
        const messageId = await write;
        return { ...entry, chatCardMessageId: messageId };
    } finally {
        if (diaryCardWrites.get(key) === write) diaryCardWrites.delete(key);
    }
}

/** Removes every chat card that represents this diary, including stale duplicates. */
export async function deleteDiaryCardMessages(entry: DiaryEntry): Promise<number[]> {
    const messages = await DB.getMessagesByCharId(entry.charId, true);
    const ids = new Set(
        messages
            .filter(message => message.type === 'score_card' && isSameDiaryCard(readDiaryCardPayload(message), entry))
            .map(message => message.id),
    );
    if (entry.chatCardMessageId) ids.add(entry.chatCardMessageId);
    const deletedIds = [...ids];
    if (deletedIds.length > 0) await DB.deleteMessages(deletedIds);
    return deletedIds;
}

export function buildActivityCardPayload(event: BackendConversationEventRecord, charName: string) {
    const metadata = event.metadata || {};
    const isMcp = event.eventType === 'mcp_activity' || event.eventType === 'tool_activity';
    return {
        type: isMcp ? 'mcp_activity_card' : 'autonomy_activity_card',
        eventId: event.id,
        eventType: event.eventType,
        charName,
        occurredAt: event.occurredAt,
        title: typeof metadata.title === 'string'
            ? metadata.title
            : isMcp ? 'MCP 探索记录' : '自由活动',
        capabilityId: typeof metadata.capabilityId === 'string' ? metadata.capabilityId : '',
        toolName: typeof metadata.toolName === 'string' ? metadata.toolName : '',
        actionName: typeof metadata.actionName === 'string' ? metadata.actionName : '',
        status: typeof metadata.status === 'string' ? metadata.status : 'completed',
        goal: typeof metadata.goal === 'string' ? metadata.goal : (event.content || ''),
        result: typeof metadata.result === 'string' ? metadata.result : '',
        summary: typeof metadata.summary === 'string' ? metadata.summary : (event.content || ''),
        durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : null,
        imageUrl: typeof metadata.imageUrl === 'string' ? metadata.imageUrl : '',
    };
}
