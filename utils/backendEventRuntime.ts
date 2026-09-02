import type {
    BackendConversationEventRecord,
    CharacterProfile,
    DiaryComment,
    DiaryEntry,
    Message,
    StickerData,
} from '../types';
import { getBackendEventCursor, getBackendEvents, getBackendPhonePeekImage, loadBackendChatConfig } from './backendClient';
import { putImageBlob } from './blobRef';
import { DB } from './db';
import { buildActivityCardPayload, upsertDiaryCardMessage } from './journalCards';
import { normalizeWebpageMediaUrls } from './webpageExtractor';

const POLL_INTERVAL_MS = 30_000;
const CURSOR_KEY_PREFIX = 'sullyos_backend_event_cursor_v1:';
const MAX_BATCHES_PER_POLL = 10;

let running = false;
let polling = false;
let timer: number | null = null;

function cursorKey(baseUrl: string): string {
    return `${CURSOR_KEY_PREFIX}${baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`;
}

function readCursor(key: string): number | null {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
        return null;
    }
}

function writeCursor(key: string, sequenceId: number): void {
    try { localStorage.setItem(key, String(sequenceId)); } catch { /* best effort */ }
}

function eventTimestamp(event: BackendConversationEventRecord): number {
    const parsed = Date.parse(event.occurredAt);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function metadataString(event: BackendConversationEventRecord, key: string): string {
    const value = event.metadata?.[key];
    return typeof value === 'string' ? value : '';
}

function diarySceneCards(event: BackendConversationEventRecord): StickerData[] {
    const value = event.metadata?.sceneCards;
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .slice(0, 2)
        .map((caption, index) => ({
            id: `scene-${event.id}-${index}`,
            url: '',
            kind: 'scene-card',
            caption: caption.trim().slice(0, 120),
            x: 30 + index * 42,
            y: 72 - index * 10,
            rotation: index === 0 ? -4 : 5,
            scale: 0.9,
        }));
}

export function buildPlatformShareMessage(
    event: BackendConversationEventRecord,
): (Omit<Message, 'id' | 'timestamp'> & { timestamp?: number }) | undefined {
    const share = event.metadata?.share;
    if (!share || typeof share !== 'object' || Array.isArray(share)) return undefined;
    const data = share as Record<string, unknown>;
    const post = data.post && typeof data.post === 'object' && !Array.isArray(data.post)
        ? data.post as Record<string, unknown>
        : data;
    const platform = typeof data.platform === 'string' ? data.platform : '';
    const title = typeof data.title === 'string' ? data.title
        : typeof post.title === 'string' ? post.title : (event.content || '分享');
    const url = typeof data.url === 'string' ? data.url : '';
    const description = typeof data.description === 'string' ? data.description
        : typeof data.excerpt === 'string' ? data.excerpt
            : typeof data.text === 'string' ? data.text
                : typeof data.full_text === 'string' ? data.full_text
                    : typeof post.description === 'string' ? post.description
                        : typeof post.excerpt === 'string' ? post.excerpt
                            : typeof post.text === 'string' ? post.text
                                : typeof post.full_text === 'string' ? post.full_text : '';
    const author = typeof data.author === 'string' ? data.author
        : typeof post.author === 'string' ? post.author
            : typeof post.handle === 'string' ? post.handle : '';
    const imageUrl = typeof data.imageUrl === 'string' ? data.imageUrl
        : typeof data.image_url === 'string' ? data.image_url
            : typeof data.image === 'string' ? data.image
                : typeof post.imageUrl === 'string' ? post.imageUrl
                    : typeof post.image_url === 'string' ? post.image_url
                        : typeof post.image === 'string' ? post.image : '';
    const mediaUrls = normalizeWebpageMediaUrls(data.mediaUrls, post.mediaUrls, imageUrl);
    const likes = Number(data.likes ?? data.like_count ?? data.likeCount ?? data.favorite_count
        ?? post.likes ?? post.like_count ?? post.likeCount ?? post.favorite_count ?? 0) || 0;
    const retweets = Number(data.retweets ?? data.retweet_count ?? data.retweetCount ?? data.repost_count
        ?? post.retweets ?? post.retweet_count ?? post.retweetCount ?? post.repost_count ?? 0) || 0;
    if (!url) return undefined;
    if (platform === 'xhs') {
        return {
            charId: event.charId,
            role: 'assistant',
            type: 'xhs_card',
            content: title,
            timestamp: eventTimestamp(event),
            metadata: {
                xhsNote: {
                    noteId: typeof data.noteId === 'string' ? data.noteId : '',
                    xsecToken: typeof data.xsecToken === 'string' ? data.xsecToken : '',
                    title,
                    desc: description,
                    author,
                    coverUrl: imageUrl,
                    likes,
                },
                source: 'backend-platform-share',
                backendEventId: event.id,
            },
        };
    }
    return {
        charId: event.charId,
        role: 'assistant',
        type: 'webpage_card',
        content: title,
        timestamp: eventTimestamp(event),
        metadata: {
            webpage: {
                url,
                finalUrl: url,
                title,
                excerpt: description,
                image: mediaUrls[0],
                mediaUrls,
                siteName: platform === 'x' ? 'X' : '网页',
                platform,
                author,
                likes,
                retweets,
            },
            source: 'backend-platform-share',
            backendEventId: event.id,
        },
    };
}

function diaryFromBackendEvent(event: BackendConversationEventRecord): DiaryEntry {
    const timestamp = eventTimestamp(event);
    const paperStyle = metadataString(event, 'paperStyle') || 'plain';
    const content = event.content?.trim() || '';
    return {
        id: metadataString(event, 'diaryExternalId') || `backend-diary-${event.id}`,
        charId: event.charId,
        date: metadataString(event, 'diaryDate') || new Date(timestamp).toISOString().slice(0, 10),
        title: metadataString(event, 'title'),
        primaryAuthor: 'character',
        userPage: { text: '', paperStyle: 'grid', stickers: [] },
        charPage: { text: content, paperStyle, stickers: diarySceneCards(event) },
        comments: [],
        timestamp,
        isArchived: false,
        autoSync: true,
        backendDiaryId: metadataString(event, 'diaryId'),
        origin: metadataString(event, 'source') === 'heartbeat' ? 'heartbeat' : 'imported',
    };
}

async function persistDiaryEntry(
    event: BackendConversationEventRecord,
    character: CharacterProfile,
    userName: string,
): Promise<boolean> {
    const backendDiaryId = metadataString(event, 'diaryId');
    const externalId = metadataString(event, 'diaryExternalId');

    // 用户在前端保存日记时，后端也会产生 diary_entry 事件。这里仅补齐后端主键，
    // 不再创建第二份日记或第二张聊天卡片。
    if (event.actorType === 'user') {
        const saved = await DB.saveBackendEvent(event);
        const diaries = await DB.getDiariesByCharId(event.charId);
        const local = diaries.find(diary =>
            (backendDiaryId && diary.backendDiaryId === backendDiaryId)
            || (externalId && diary.id === externalId),
        );
        if (local && backendDiaryId && local.backendDiaryId !== backendDiaryId) {
            await DB.saveDiary({ ...local, backendDiaryId });
        }
        return saved.created;
    }

    const existing = backendDiaryId
        ? await DB.getDiaryByBackendId(event.charId, backendDiaryId)
        : null;
    const entry: DiaryEntry = existing
        ? {
            ...existing,
            title: metadataString(event, 'title') || existing.title,
            date: metadataString(event, 'diaryDate') || existing.date,
            charPage: {
                text: event.content?.trim() || existing.charPage?.text || '',
                paperStyle: metadataString(event, 'paperStyle') || existing.charPage?.paperStyle || 'plain',
                stickers: existing.charPage?.stickers?.some(sticker => sticker.kind === 'scene-card')
                    ? existing.charPage.stickers
                    : [...(existing.charPage?.stickers || []), ...diarySceneCards(event)],
            },
            backendDiaryId: backendDiaryId || existing.backendDiaryId,
        }
        : diaryFromBackendEvent(event);
    const saved = await DB.saveBackendEvent(event);
    const withCard = await upsertDiaryCardMessage(entry, character, userName, 'backend-journal');
    await DB.saveDiary(withCard);
    return saved.created;
}

async function persistDiaryComment(
    event: BackendConversationEventRecord,
    character: CharacterProfile,
    userName: string,
): Promise<boolean> {
    const saved = await DB.saveBackendEvent(event);
    const backendDiaryId = metadataString(event, 'diaryId');
    if (!backendDiaryId || !event.content?.trim()) return saved.created;
    const comment: DiaryComment = {
        id: metadataString(event, 'commentExternalId') || `backend-comment-${event.id}`,
        backendCommentId: event.id,
        author: event.actorType === 'user' ? 'user' : 'character',
        content: event.content.trim(),
        createdAt: eventTimestamp(event),
        replyToId: metadataString(event, 'replyToId') || undefined,
    };
    const merged = await DB.mergeDiaryComment(event.charId, backendDiaryId, comment);
    if (!merged.diary || !merged.changed) return saved.created;
    const withCard = await upsertDiaryCardMessage(merged.diary, character, userName, 'backend-journal');
    if (withCard.chatCardMessageId !== merged.diary.chatCardMessageId) await DB.saveDiary(withCard);
    return true;
}

async function persistEvent(
    event: BackendConversationEventRecord,
    characters: Map<string, CharacterProfile>,
    userName: string,
): Promise<void> {
    const character = characters.get(event.charId);
    if (!character) {
        const saved = await DB.saveBackendEvent(event);
        if (saved.created) window.dispatchEvent(new CustomEvent('backend-event-received', { detail: event }));
        return;
    }
    if (event.eventType === 'diary_entry') {
        const created = await persistDiaryEntry(event, character, userName);
        window.dispatchEvent(new CustomEvent('backend-event-received', { detail: event }));
        if (created && event.actorType === 'assistant') {
            window.dispatchEvent(new CustomEvent('journal-entry-received', {
                detail: { charId: event.charId, charName: event.charName || character.name },
            }));
        }
        return;
    }
    if (event.eventType === 'diary_comment') {
        const created = await persistDiaryComment(event, character, userName);
        window.dispatchEvent(new CustomEvent('backend-event-received', { detail: event }));
        if (created && event.actorType === 'assistant') {
            window.dispatchEvent(new CustomEvent('journal-comment-received', {
                detail: { charId: event.charId, charName: event.charName || character.name },
            }));
        }
        return;
    }
    const isActivityCard = ['autonomous_activity', 'mcp_activity', 'activity_summary', 'tool_activity']
        .includes(event.eventType);
    const isPlatformShare = event.eventType === 'platform_share';
    const isPhoneScreenshot = event.eventType === 'user_message'
        && metadataString(event, 'source') === 'phone-peek'
        && Boolean(metadataString(event, 'imagePath'));
    const isProactiveMessage = event.eventType === 'proactive_message'
        && Boolean(event.content?.trim())
        && Boolean(character);
    let activityCard = isActivityCard
        ? buildActivityCardPayload(event, event.charName || character.name)
        : null;
    const sharedLinkCard = isPlatformShare ? buildPlatformShareMessage(event) : undefined;
    const imagePath = metadataString(event, 'imagePath');
    const phoneScreenshotMessage = isPhoneScreenshot ? {
        charId: event.charId,
        role: 'user' as const,
        type: 'image' as const,
        content: await putImageBlob(await getBackendPhonePeekImage(loadBackendChatConfig(), imagePath)),
        timestamp: eventTimestamp(event),
        metadata: {
            ...event.metadata,
            source: 'backend-phone-peek',
            backendEventId: event.id,
            backendEventType: event.eventType,
            backendSequenceId: event.sequenceId,
        },
    } : undefined;
    if (activityCard && imagePath) {
        try {
            const imageUrl = await putImageBlob(await getBackendPhonePeekImage(loadBackendChatConfig(), imagePath));
            activityCard = { ...activityCard, imageUrl };
        } catch (error) {
            console.debug('[backend-events] phone peek image deferred', error);
        }
    }
    const saved = await DB.saveBackendEvent(
        event,
        phoneScreenshotMessage ?? (isProactiveMessage ? {
            charId: event.charId,
            role: 'assistant',
            type: 'text',
            content: event.content!.trim(),
            timestamp: eventTimestamp(event),
            metadata: {
                ...event.metadata,
                source: 'backend-heartbeat',
                proactive: true,
                backendEventId: event.id,
                backendEventType: event.eventType,
                backendSequenceId: event.sequenceId,
            },
        } : sharedLinkCard ? sharedLinkCard : activityCard ? {
            charId: event.charId,
            role: 'system',
            type: 'score_card',
            content: JSON.stringify(activityCard),
            timestamp: eventTimestamp(event),
            metadata: {
                scoreCard: activityCard,
                source: 'backend-autonomy',
                backendEventId: event.id,
                backendEventType: event.eventType,
                backendSequenceId: event.sequenceId,
            },
        } : undefined),
    );

    if (!saved.created) return;
    window.dispatchEvent(new CustomEvent('backend-event-received', { detail: event }));
    if (activityCard || sharedLinkCard) {
        window.dispatchEvent(new CustomEvent('backend-card-received', {
            detail: {
                charId: event.charId,
                charName: event.charName || character.name,
                eventType: event.eventType,
            },
        }));
    }
    if (!isProactiveMessage) return;

    window.dispatchEvent(new CustomEvent('active-msg-received', {
        detail: {
            charId: event.charId,
            charName: event.charName || character?.name || '角色',
            body: event.content!.trim(),
            avatarUrl: character?.avatar,
            sentAt: eventTimestamp(event),
            backendEventId: event.id,
        },
    }));
}

export async function pollBackendEventsNow(): Promise<void> {
    if (!running || polling) return;
    const config = loadBackendChatConfig();
    // 当前开关开启时才建立回流连接。心跳功能启用前会先要求打开后端聊天，
    // 避免未使用新后端的用户每 30 秒收到一次无意义的连接失败。
    if (!config.enabled) return;

    polling = true;
    try {
        const key = cursorKey(config.baseUrl);
        let cursor = readCursor(key);
        if (cursor === null) {
            // 首次接入只建立基线，不回放迁移进后端的全部旧聊天。
            cursor = await getBackendEventCursor(config);
            writeCursor(key, cursor);
            return;
        }

        const characters = new Map(
            (await DB.getAllCharacters()).map(character => [character.id, character]),
        );
        const userName = (await DB.getUserProfile())?.name || '我';
        for (let batch = 0; batch < MAX_BATCHES_PER_POLL; batch += 1) {
            const events = await getBackendEvents(config, cursor, 200);
            if (events.length === 0) break;
            for (const event of events) {
                await persistEvent(event, characters, userName);
                cursor = event.sequenceId;
                // 只有本条事件已经幂等落库后才推进游标，断电/刷新不会丢消息。
                writeCursor(key, cursor);
            }
            if (events.length < 200) break;
        }
    } catch (error) {
        // 后端关机或临时断网是正常状态；下一次轮询/回到前台时自动补拉。
        console.debug('[backend-events] poll deferred', error);
    } finally {
        polling = false;
    }
}

export function startBackendEventRuntime(): () => void {
    if (running) return () => {};
    running = true;
    const onVisible = () => {
        if (document.visibilityState === 'visible') void pollBackendEventsNow();
    };
    const onFocus = () => void pollBackendEventsNow();
    const onServiceWorkerMessage = (event: MessageEvent) => {
        if (event.data?.type === 'sullyos-backend-push') void pollBackendEventsNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    timer = window.setInterval(() => void pollBackendEventsNow(), POLL_INTERVAL_MS);
    void pollBackendEventsNow();

    return () => {
        running = false;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onFocus);
        navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
        if (timer !== null) window.clearInterval(timer);
        timer = null;
    };
}
