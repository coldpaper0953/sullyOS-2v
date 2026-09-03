import type {
    BackendConversationEventRecord,
    BackendConversationEventType,
    CharacterProfile,
    Message,
    UserProfile,
} from '../types';
import type {
    Anticipation,
    DigestReport,
    EventBox,
    MemoryBatch,
    MemoryLink,
    MemoryNode,
    MemoryVector,
    RoomPlate,
    TopicBox,
} from './memoryPalace/types';
import {
    acknowledgeBackendMemoryChanges,
    getBackendMemoryChanges,
    getBackendMemoryChangesByKeys,
    type BackendMemoryChange,
} from './backendSyncQueue';
import {
    bytesToB64u,
    describePushCapabilityGap,
    subscribeWithRetry,
    SUBSCRIBE_SETTLE_MS,
} from './pushSubscribeShared';
import { DB } from './db';
import { relevantNpcNetwork } from './npcNetwork';
import { resolveCharTimeZone } from './timezone';
import { getDailyScheduleForChar } from './dailySchedule';

const CONFIG_KEY = 'sullyos_backend_chat_v1';
const CLIENT_ID_KEY = 'sullyos_backend_client_id_v1';

// 自主后端默认地址：永远是本机的自建服务端口。
// 曾经在 https 站点上默认取 window.location.origin——那是静态站点自己的地址（GitHub
// Pages 之类），根本不是后端：面板看起来像"已经配好了"，一旦开启就会朝着放页面的
// 静态主机反复发 /v1/... 请求并全部 404（用户在网络日志里看到"请求发去了 git 仓库"）。
const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:43210';

export interface BackendChatConfig {
    enabled: boolean;
    serverContextEnabled: boolean;
    baseUrl: string;
    token: string;
}

export interface BackendConnectionResult {
    ok: boolean;
    service?: string;
    modelConfigured?: boolean;
    model?: string | null;
    providerOrigin?: string | null;
    mode?: 'auto' | 'fixed';
    activeProfileId?: string | null;
    lastUsedProfileId?: string | null;
    profiles?: BackendModelProfile[];
    message?: string;
}

export interface BackendModelProfile {
    id: string;
    label: string;
    model: string;
    providerOrigin: string | null;
    priority: number;
    enabled: boolean;
    readOnly: boolean;
    healthStatus: 'unknown' | 'healthy' | 'unhealthy';
    cooldownUntil: string | null;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastError: string | null;
}

export interface BackendModelPool {
    routing: {
        mode: 'auto' | 'fixed';
        activeProfileId: string | null;
        lastUsedProfileId: string | null;
    };
    profiles: BackendModelProfile[];
}

export interface BackendCapability {
    id: string;
    label: string;
    description: string;
    risk: 'internal' | 'read' | 'write';
    available: boolean;
}

export interface BackendAgentAutonomy {
    characterId: string;
    name: string;
    enabled: boolean;
    intervalMinutes: number;
    timezone: string;
    policy: {
        allowedCapabilityIds: string[];
        approvalMode: 'read_only_auto' | 'ask_all' | 'trusted';
        maxToolStepsPerWake: number;
        dailyToolBudget: number;
        idleThresholdMinutes: number;
        cooldownMinutes: number;
        probabilityLevel: 'low' | 'mid' | 'high';
        activityWindow: {
            enabled: boolean;
            start: string;
            end: string;
        };
    };
    lastHeartbeatAt: string | null;
    nextWakeAt: string | null;
    lastRun: {
        status: string | null;
        action: string | null;
        reason: string | null;
        error: string | null;
        at: string;
    } | null;
}

export interface BackendAgentsResult {
    agents: BackendAgentAutonomy[];
    capabilities: BackendCapability[];
}

export interface BackendPushConfig {
    configured: boolean;
    publicKey: string | null;
    activeSubscriptions: number;
}

export interface BackendPushEnableResult {
    enabled: boolean;
    endpoint: string;
}

export type BackendToolConnectionId = 'x.read' | 'xhs.read' | 'web.read' | 'mcp.read' | 'phone.read';

export interface BackendToolConnection {
    id: BackendToolConnectionId;
    label: string;
    enabled: boolean;
    endpoint: string;
    settings: Record<string, unknown>;
    secretKeys: string[];
    lastHealthStatus: string;
    lastHealthError: string | null;
    lastHealthAt: string | null;
}

export interface BackendToolsResult {
    connections: BackendToolConnection[];
    capabilities: BackendCapability[];
}

export interface BackendDiaryComment {
    id: string;
    diaryId: string;
    externalId: string | null;
    authorType: 'user' | 'assistant';
    content: string;
    replyToId: string | null;
    eventId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface BackendDiary {
    id: string;
    externalId: string | null;
    characterId: string;
    characterName: string;
    authorType: 'user' | 'assistant';
    title: string;
    content: string;
    paperStyle: string;
    diaryDate: string;
    metadata: Record<string, unknown>;
    eventId: string | null;
    comments: BackendDiaryComment[];
    createdAt: string;
    updatedAt: string;
}

const DEFAULT_CONFIG: BackendChatConfig = {
    enabled: false,
    serverContextEnabled: false,
    baseUrl: DEFAULT_BACKEND_BASE_URL,
    token: '',
};

export async function exchangeBackendPairingCode(baseUrl: string, code: string): Promise<BackendChatConfig> {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const response = await fetch(`${normalizedBaseUrl}/v1/pair/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body?.data?.token !== 'string') {
        throw new Error(body?.error === 'invalid_pairing_code' ? '配对码无效或已过期' : '配对失败');
    }
    return saveBackendChatConfig({
        enabled: true,
        serverContextEnabled: false,
        baseUrl: normalizedBaseUrl,
        token: body.data.token,
    });
}

export async function createBackendPairingCode(config: BackendChatConfig): Promise<{
    code: string;
    expiresAt: string;
}> {
    const result = await backendFetch(config, '/v1/pairing-codes', { method: 'POST' });
    return result.data;
}

export function loadBackendChatConfig(): BackendChatConfig {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_CONFIG };
        const parsed = JSON.parse(raw) as Partial<BackendChatConfig>;
        return {
            enabled: parsed.enabled === true,
            // 普通聊天始终复用前端成熟的完整提示词；自主心跳另走服务端上下文。
            serverContextEnabled: false,
            baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
                ? parsed.baseUrl.trim().replace(/\/+$/, '')
                : DEFAULT_CONFIG.baseUrl,
            token: typeof parsed.token === 'string' && parsed.token.trim()
                ? parsed.token.trim()
                : DEFAULT_CONFIG.token,
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function saveBackendChatConfig(config: BackendChatConfig): BackendChatConfig {
    const normalized = {
        enabled: config.enabled === true,
        serverContextEnabled: config.serverContextEnabled === true,
        baseUrl: config.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_CONFIG.baseUrl,
        token: config.token.trim() || DEFAULT_CONFIG.token,
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
    return normalized;
}

function getClientId(): string {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
}

export async function getBackendPushConfig(config: BackendChatConfig): Promise<BackendPushConfig> {
    const result = await backendFetch(config, '/v1/push/config');
    return result.data as BackendPushConfig;
}

export async function enableBackendPush(config: BackendChatConfig): Promise<BackendPushEnableResult> {
    const gap = describePushCapabilityGap();
    if (gap) throw new Error(gap);
    const remote = await getBackendPushConfig(config);
    if (!remote.configured || !remote.publicKey) throw new Error('VPS 尚未配置 Web Push 密钥');

    let permission = Notification.permission;
    if (permission !== 'granted') permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('通知权限未授予');

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const existingKey = subscription?.options.applicationServerKey
        ? bytesToB64u(subscription.options.applicationServerKey)
        : '';
    if (subscription && existingKey && existingKey !== remote.publicKey) {
        await subscription.unsubscribe();
        subscription = null;
        await new Promise(resolve => window.setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
    }
    if (!subscription) {
        const created = await subscribeWithRetry(registration, remote.publicKey, '[BackendPush]');
        if (!created.sub) throw new Error(`浏览器没有创建推送订阅：${created.failure?.kind || '未知原因'}`);
        subscription = created.sub;
    }

    const p256dh = bytesToB64u(subscription.getKey('p256dh'));
    const auth = bytesToB64u(subscription.getKey('auth'));
    if (!p256dh || !auth) throw new Error('浏览器返回的推送订阅缺少加密密钥');
    await backendFetch(config, '/v1/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
            clientId: getClientId(),
            clientName: navigator.userAgent.slice(0, 180),
            endpoint: subscription.endpoint,
            keys: { p256dh, auth },
            expirationTime: subscription.expirationTime,
        }),
    });
    return { enabled: true, endpoint: subscription.endpoint };
}

export async function disableBackendPush(config: BackendChatConfig): Promise<void> {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await backendFetch(config, '/v1/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
}

export async function testBackendPush(config: BackendChatConfig): Promise<{
    attempted: number;
    delivered: number;
    retryableFailures: number;
}> {
    const result = await backendFetch(config, '/v1/push/test', {
        method: 'POST',
        body: JSON.stringify({ clientId: getClientId() }),
    });
    return result.data;
}

async function backendFetch(
    config: BackendChatConfig,
    path: string,
    init: RequestInit = {},
): Promise<any> {
    const controller = new AbortController();
    const timeoutMs = path.startsWith('/v1/events') ? 15_000 : 310_000;
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const hasBody = init.body !== undefined && init.body !== null;
        const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${config.token}`,
                ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers || {}),
            },
            signal: controller.signal,
        });
        const text = await response.text();
        let body: any = {};
        try { body = text ? JSON.parse(text) : {}; }
        catch { body = {}; }
        if (!response.ok) {
            const validationDetails = Array.isArray(body?.details)
                ? body.details.slice(0, 3).map((issue: any) => {
                    const path = Array.isArray(issue?.path) ? issue.path.join('.') : '';
                    return `${path || '请求'}：${issue?.message || '格式不正确'}`;
                }).join('；')
                : '';
            throw new Error(
                body?.message
                || (validationDetails ? `${body?.error || 'invalid_request'}（${validationDetails}）` : '')
                || body?.error
                || `后端返回 HTTP ${response.status}`,
            );
        }
        return body;
    } finally {
        window.clearTimeout(timeout);
    }
}

export async function testBackendConnection(config: BackendChatConfig): Promise<BackendConnectionResult> {
    try {
        const [healthResponse, modelResponse] = await Promise.all([
            fetch(`${config.baseUrl.replace(/\/+$/, '')}/health`),
            backendFetch(config, '/v1/model/status'),
        ]);
        if (!healthResponse.ok) throw new Error(`健康检查 HTTP ${healthResponse.status}`);
        const health = await healthResponse.json();
        const status = modelResponse?.data || {};
        return {
            ok: health?.ok === true,
            service: health?.service,
            modelConfigured: status.configured === true,
            model: status.model ?? null,
            providerOrigin: status.providerOrigin ?? null,
            mode: status.mode,
            activeProfileId: status.activeProfileId ?? null,
            lastUsedProfileId: status.lastUsedProfileId ?? null,
            profiles: Array.isArray(status.profiles) ? status.profiles : [],
        };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '连接失败' };
    }
}

export async function getBackendModelPool(config: BackendChatConfig): Promise<BackendModelPool> {
    const result = await backendFetch(config, '/v1/model/profiles');
    return result.data as BackendModelPool;
}

export async function discoverBackendModels(
    config: BackendChatConfig,
    input: { baseUrl: string; apiKey: string },
): Promise<string[]> {
    const result = await backendFetch(config, '/v1/model/discover', {
        method: 'POST',
        body: JSON.stringify(input),
    });
    return Array.isArray(result?.data?.models)
        ? result.data.models.filter((model: unknown): model is string => typeof model === 'string')
        : [];
}

export async function addBackendModelProfile(
    config: BackendChatConfig,
    input: { label: string; baseUrl: string; apiKey: string; model: string; priority?: number },
): Promise<void> {
    await backendFetch(config, '/v1/model/profiles', {
        method: 'POST',
        body: JSON.stringify({ ...input, enabled: true, priority: input.priority ?? 100 }),
    });
}

export async function deleteBackendModelProfile(
    config: BackendChatConfig,
    profileId: string,
): Promise<void> {
    await backendFetch(config, `/v1/model/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
}

export async function updateBackendModelRouting(
    config: BackendChatConfig,
    input: { mode: 'auto' | 'fixed'; activeProfileId: string | null },
): Promise<void> {
    await backendFetch(config, '/v1/model/routing', {
        method: 'PUT',
        body: JSON.stringify(input),
    });
}

export async function getBackendAgents(config: BackendChatConfig): Promise<BackendAgentsResult> {
    const result = await backendFetch(config, '/v1/agents');
    return result.data as BackendAgentsResult;
}

export async function getBackendTools(config: BackendChatConfig): Promise<BackendToolsResult> {
    const result = await backendFetch(config, '/v1/tools');
    return result.data as BackendToolsResult;
}

export async function updateBackendTool(
    config: BackendChatConfig,
    id: BackendToolConnectionId,
    input: Pick<BackendToolConnection, 'label' | 'enabled' | 'endpoint' | 'settings'> & {
        secrets?: Record<string, string>;
    },
): Promise<{ connection: BackendToolConnection; generatedDeviceToken?: string }> {
    const result = await backendFetch(config, `/v1/tools/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...input, secrets: input.secrets || {} }),
    });
    return result.data;
}

export async function testBackendTool(
    config: BackendChatConfig,
    id: BackendToolConnectionId,
): Promise<{ ok: boolean; message: string; connection: BackendToolConnection }> {
    const result = await backendFetch(config, `/v1/tools/${encodeURIComponent(id)}/test`, {
        method: 'POST',
    });
    return result.data;
}

export interface BackendXSessionStatus {
    loggedIn: boolean;
    hasCt0: boolean;
    pageUrl: string;
    selfHandle: string;
}

export async function getBackendXSession(config: BackendChatConfig): Promise<BackendXSessionStatus> {
    const result = await backendFetch(config, '/v1/tools/x.read/session');
    return result.data as BackendXSessionStatus;
}

export async function updateBackendXSession(
    config: BackendChatConfig,
    input: { authToken: string; ct0?: string },
): Promise<BackendXSessionStatus> {
    const result = await backendFetch(config, '/v1/tools/x.read/session', {
        method: 'POST', body: JSON.stringify(input),
    });
    return result.data as BackendXSessionStatus;
}

export interface BackendXFeedItem {
    platform: 'x'; url: string; title: string; description: string; author: string; imageUrl?: string; mediaUrls?: string[]; likes?: number; retweets?: number;
}
export interface BackendXFollowingAccount {
    handle: string; name: string; bio: string;
}
export async function getBackendXFeed(config: BackendChatConfig, input: { view: 'home' | 'notifications' | 'profile'; handle?: string; owner?: 'user' | 'character' }): Promise<{ items: BackendXFeedItem[]; view: string; fetchedAt: string }> {
    const result = await backendFetch(config, '/v1/tools/x.read/feed', { method: 'POST', body: JSON.stringify(input) });
    return result.data;
}
export async function getBackendXStatus(config: BackendChatConfig, url: string): Promise<BackendXFeedItem | null> {
    const result = await backendFetch(config, '/v1/tools/x.read/status', { method: 'POST', body: JSON.stringify({ url }) });
    return (result.data || null) as BackendXFeedItem | null;
}
export async function getBackendXFollowing(config: BackendChatConfig): Promise<{ accounts: BackendXFollowingAccount[]; fetchedAt: string }> {
    const result = await backendFetch(config, '/v1/tools/x.read/following', { method: 'POST' });
    return result.data;
}

export interface BackendPhoneDeviceTokenResult {
    deviceToken: string;
    pendingPath: string;
    uploadPath: string;
}

export interface BackendPhonePeekReaction {
    action: 'message';
    intent: 'tease' | 'care' | 'comment' | 'curious';
    content: string;
    reasonSummary: string;
}

export interface BackendPhonePeekStatus {
    requestId: string;
    status: 'pending' | 'uploaded' | 'analyzed' | 'failed' | 'expired';
    goal: string;
    expiresAt: string;
    analysis: string | null;
    reaction: BackendPhonePeekReaction | null;
    messageEventId: string | null;
    characterId: string;
    characterName: string;
    createdAt?: string;
    updatedAt?: string;
}

export async function rotateBackendPhoneDeviceToken(
    config: BackendChatConfig,
): Promise<BackendPhoneDeviceTokenResult> {
    const result = await backendFetch(config, '/v1/tools/phone.read/device-token', { method: 'POST' });
    return result.data as BackendPhoneDeviceTokenResult;
}

export async function createBackendPhonePeekTest(
    config: BackendChatConfig,
    input: { characterId: string; goal?: string },
): Promise<{ requestId: string; summary: string }> {
    const result = await backendFetch(config, '/v1/phone/peek/test', {
        method: 'POST',
        body: JSON.stringify(input),
    });
    return result.data;
}

export async function getBackendPhonePeekStatus(
    config: BackendChatConfig,
    requestId: string,
): Promise<BackendPhonePeekStatus> {
    const result = await backendFetch(config, `/v1/phone/peek/${encodeURIComponent(requestId)}/status`);
    return result.data as BackendPhonePeekStatus;
}

export async function getBackendPhonePeekImage(
    config: BackendChatConfig,
    imagePath: string,
): Promise<Blob> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}${imagePath}`, {
            headers: { Authorization: `Bearer ${config.token}` },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`截图读取失败：HTTP ${response.status}`);
        return response.blob();
    } finally {
        window.clearTimeout(timeout);
    }
}

export async function updateBackendAgentAutonomy(
    config: BackendChatConfig,
    characterId: string,
    input: Pick<BackendAgentAutonomy, 'enabled' | 'intervalMinutes' | 'policy'> & { timezone?: string },
): Promise<BackendAgentAutonomy> {
    const result = await backendFetch(
        config,
        `/v1/agents/${encodeURIComponent(characterId)}/autonomy`,
        {
            method: 'PATCH',
            body: JSON.stringify({
                enabled: input.enabled,
                intervalMinutes: input.intervalMinutes,
                ...input.policy,
                timezone: input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            }),
        },
    );
    return result.data as BackendAgentAutonomy;
}

const MAX_MESSAGE_CONTENT = 190_000;
const MEMORY_ROOMS = new Set([
    'living_room', 'bedroom', 'study', 'user_room', 'self_room', 'attic', 'windowsill',
]);

function boundedText(value: unknown, max: number, fallback = ''): string {
    const text = typeof value === 'string' ? value : String(value ?? fallback);
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 18))}\n[内容过长，已截断]`;
}

function safeTimestamp(value: unknown, fallback = Date.now()): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return Math.max(0, Math.trunc(fallback));
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(numeric)));
}

function normalizedMessageContent(message: Message): string {
    const raw = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    if (/^data:/i.test(raw.trim())) {
        if (message.type === 'image') return '[图片内容保留在前端备份中]';
        if (message.type === 'emoji') return '[表情内容保留在前端备份中]';
        return '[媒体内容保留在前端备份中]';
    }
    return boundedText(raw, MAX_MESSAGE_CONTENT);
}

function mapMessage(message: Message) {
    const backendEventId = typeof message.metadata?.backendEventId === 'string'
        ? message.metadata.backendEventId
        : undefined;
    return {
        id: safeTimestamp(message.id),
        role: message.role,
        type: boundedText(message.type || 'text', 100, 'text') || 'text',
        content: normalizedMessageContent(message),
        timestamp: safeTimestamp(message.timestamp, safeTimestamp(message.id)),
        ...(backendEventId ? { metadata: { backendEventId } } : {}),
        ...(message.replyTo ? { replyTo: {
            id: safeTimestamp(message.replyTo.id),
            content: boundedText(message.replyTo.content, 20_000),
            name: boundedText(message.replyTo.name, 200),
        } } : {}),
    };
}

function mapMemory(memory: MemoryNode) {
    const valence = Number.isFinite(memory.valence) ? Math.max(-1, Math.min(1, memory.valence!)) : null;
    const arousal = Number.isFinite(memory.arousal) ? Math.max(-1, Math.min(1, memory.arousal!)) : null;
    const origin = memory.origin === 'extraction' || memory.origin === 'digestion' || memory.origin === 'system'
        ? memory.origin
        : null;
    return {
        id: boundedText(memory.id, 200, `memory-${safeTimestamp(memory.createdAt)}`) || `memory-${safeTimestamp(memory.createdAt)}`,
        content: boundedText(memory.content, 190_000, '[空记忆]') || '[空记忆]',
        room: MEMORY_ROOMS.has(memory.room) ? memory.room : 'living_room',
        tags: (Array.isArray(memory.tags) ? memory.tags : []).slice(0, 100).map(tag => boundedText(tag, 200)),
        importance: Math.max(1, Math.min(10, Math.trunc(Number(memory.importance) || 5))),
        mood: boundedText(memory.mood || '', 200),
        valence,
        arousal,
        embedded: memory.embedded === true,
        createdAt: safeTimestamp(memory.createdAt),
        lastAccessedAt: safeTimestamp(memory.lastAccessedAt, safeTimestamp(memory.createdAt)),
        accessCount: Math.max(0, Math.trunc(Number(memory.accessCount) || 0)),
        pinnedUntil: memory.pinnedUntil == null ? null : safeTimestamp(memory.pinnedUntil),
        sourceId: memory.sourceId == null ? null : boundedText(memory.sourceId, 200),
        origin,
        digestedAt: memory.digestedAt == null ? null : safeTimestamp(memory.digestedAt),
        eventBoxId: memory.eventBoxId == null ? null : boundedText(memory.eventBoxId, 200),
        archived: memory.archived === true,
        isBoxSummary: memory.isBoxSummary === true,
        metadata: {
            ...(memory.groupId ? { groupId: memory.groupId } : {}),
            ...(memory.groupName ? { groupName: memory.groupName } : {}),
            ...(memory.legacyCsy ? { legacyCsy: memory.legacyCsy } : {}),
            ...(memory.boxId ? { legacyTopicBoxId: memory.boxId } : {}),
            ...(memory.boxTopic ? { legacyTopicSummary: memory.boxTopic } : {}),
        },
    };
}

export async function syncBackendContext(input: {
    config: BackendChatConfig;
    character: CharacterProfile;
    user: UserProfile;
    messages: Message[];
    memories: MemoryNode[];
    snapshotId?: string;
    deletedMessageIds?: number[];
    deletedEventIds?: string[];
    deletedMemoryIds?: string[];
}): Promise<any> {
    const { character, user } = input;
    const currentDailySchedule = await getDailyScheduleForChar(character).catch(() => null);
    return backendFetch(input.config, '/v1/context/sync', {
        method: 'POST',
        body: JSON.stringify({
            clientId: getClientId(),
            ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
            clientName: 'SharkOS Web',
            user: {
                name: boundedText(user.name, 200, '用户') || '用户',
                bio: boundedText(user.bio || '', 100_000),
            },
            character: {
                id: boundedText(character.id, 200),
                name: boundedText(character.name, 200, '未命名角色') || '未命名角色',
                description: boundedText(character.description || '', 100_000),
                systemPrompt: boundedText(character.systemPrompt || '', 200_000),
                worldview: character.worldview == null ? null : boundedText(character.worldview, 100_000),
                writerPersona: character.writerPersona == null ? null : boundedText(character.writerPersona, 100_000),
                legacyMemories: (Array.isArray(character.memories) ? character.memories : []).slice(0, 5_000).map((memory, index) => ({
                    id: boundedText(memory?.id, 200, `legacy-${index}`) || `legacy-${index}`,
                    date: boundedText(memory?.date, 100),
                    summary: boundedText(memory?.summary, 20_000),
                    ...(memory?.mood ? { mood: boundedText(memory.mood, 200) } : {}),
                })),
                refinedMemories: Object.fromEntries(
                    Object.entries(character.refinedMemories || {}).map(([key, value]) => [
                        boundedText(key, 500), boundedText(value, 100_000),
                    ]),
                ),
                metadata: {
                    // 主项目没有 002 的「线下相处模式」字段：按线上聊天上报，与该功能
                    // 缺省时的行为一致；后端 contextMapping 只读这两个键，缺省安全。
                    interactionMode: (character as CharacterProfile & { interactionMode?: 'online' | 'offline' }).interactionMode === 'offline' ? 'offline' : 'online',
                    ...((character as CharacterProfile & { interactionScene?: unknown }).interactionScene
                        ? { interactionScene: (character as CharacterProfile & { interactionScene?: unknown }).interactionScene }
                        : {}),
                    ...(currentDailySchedule ? { currentDailySchedule } : {}),
                    npcNetwork: relevantNpcNetwork(user.npcNetwork, character.id),
                },
                timezone: resolveCharTimeZone(character)
                    || Intl.DateTimeFormat().resolvedOptions().timeZone
                    || 'UTC',
            },
            // 后端生成的 assistant 消息已经在 conversation_events 中；前端只保留其
            // 展示副本，下一轮同步时跳过，避免同一回复被写两遍。
            messages: input.messages
                .filter(message => !(message.role === 'assistant' && message.metadata?.backendEventId))
                .slice(-1_000)
                .map(mapMessage),
            memories: input.memories.slice(0, 5_000).map(mapMemory),
            deletedMessageIds: (input.deletedMessageIds || [])
                .slice(0, 5_000)
                .map(value => Math.max(0, Math.trunc(Number(value) || 0))),
            deletedEventIds: (input.deletedEventIds || []).slice(0, 5_000),
            deletedMemoryIds: (input.deletedMemoryIds || []).slice(0, 5_000).map(id => boundedText(id, 200)),
        }),
    });
}

export async function deleteBackendCharacter(
    config: BackendChatConfig,
    characterId: string,
): Promise<void> {
    await backendFetch(config, '/v1/context/' + encodeURIComponent(characterId), {
        method: 'DELETE',
    });
}

export async function deleteBackendMemoryPalace(config: BackendChatConfig): Promise<void> {
    await backendFetch(config, '/v1/memory-palace', {
        method: 'DELETE',
    });
}

export async function syncBackendCharacterFully(input: {
    config: BackendChatConfig;
    character: CharacterProfile;
    user: UserProfile;
    messages: Message[];
    memories: MemoryNode[];
    snapshotId?: string;
    onProgress?: (done: number, total: number) => void;
}): Promise<{ messages: number; memories: number; rounds: number }> {
    const messages = input.messages.filter(
        message => !(message.role === 'assistant' && message.metadata?.backendEventId),
    );
    const messageRounds = Math.ceil(messages.length / 1_000);
    const memoryRounds = Math.ceil(input.memories.length / 5_000);
    const rounds = Math.max(1, messageRounds, memoryRounds);

    for (let index = 0; index < rounds; index += 1) {
        await syncBackendContext({
            config: input.config,
            character: input.character,
            user: input.user,
            messages: messages.slice(index * 1_000, (index + 1) * 1_000),
            memories: input.memories.slice(index * 5_000, (index + 1) * 5_000),
            snapshotId: input.snapshotId,
        });
        input.onProgress?.(index + 1, rounds);
    }

    return { messages: messages.length, memories: input.memories.length, rounds };
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function mapVector(vector: MemoryVector) {
    let bytes: Uint8Array;
    if (vector.vector instanceof Uint8Array && !(vector.vector instanceof Float32Array)) {
        bytes = new Uint8Array(vector.vector.buffer, vector.vector.byteOffset, vector.vector.byteLength);
    } else {
        const floats = vector.vector instanceof Float32Array
            ? vector.vector
            : Float32Array.from(vector.vector as number[]);
        bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
    }
    return {
        memoryId: boundedText(vector.memoryId, 200),
        dimensions: Math.max(1, Math.min(65_536, Math.trunc(Number(vector.dimensions) || 1))),
        model: vector.model ? boundedText(vector.model, 500) : null,
        vectorBase64: bytesToBase64(bytes),
    };
}

export async function syncBackendMemoryPalaceFully(input: {
    config: BackendChatConfig;
    characterId: string;
    eventBoxes: EventBox[];
    roomPlates: RoomPlate[];
    links: MemoryLink[];
    anticipations: Anticipation[];
    digestReports: DigestReport[];
    vectors: MemoryVector[];
    batches: MemoryBatch[];
    topicBoxes: TopicBox[];
    snapshotId: string;
    onProgress?: (done: number, total: number) => void;
}): Promise<{
    eventBoxes: number;
    roomPlates: number;
    links: number;
    anticipations: number;
    digestReports: number;
    vectors: number;
    batches: number;
    topicBoxes: number;
    backendCounts: Record<string, number>;
}> {
    const eventBoxes = input.eventBoxes.map(box => ({
        id: boundedText(box.id, 200),
        name: boundedText(box.name, 2_000),
        tags: (box.tags || []).slice(0, 200).map(tag => boundedText(tag, 200)),
        summaryNodeId: box.summaryNodeId ? boundedText(box.summaryNodeId, 200) : null,
        liveMemoryIds: (box.liveMemoryIds || []).slice(0, 10_000).map(value => boundedText(value, 200)),
        archivedMemoryIds: (box.archivedMemoryIds || []).slice(0, 50_000).map(value => boundedText(value, 200)),
        compressionCount: Math.max(0, Math.trunc(Number(box.compressionCount) || 0)),
        createdAt: safeTimestamp(box.createdAt),
        updatedAt: safeTimestamp(box.updatedAt, safeTimestamp(box.createdAt)),
        lastCompressedAt: box.lastCompressedAt == null ? null : safeTimestamp(box.lastCompressedAt),
        sealed: box.sealed === true,
        predecessorBoxId: box.predecessorBoxId ? boundedText(box.predecessorBoxId, 200) : null,
    }));
    const roomPlates = input.roomPlates.map(plate => ({
        id: boundedText(plate.id, 200),
        room: plate.room,
        entries: (plate.entries || []).slice(0, 500).map((entry, index) => ({
            id: boundedText(entry.id, 200, `plate-entry-${index}`) || `plate-entry-${index}`,
            text: boundedText(entry.text, 10_000, '[空门牌条目]') || '[空门牌条目]',
            firstLearnedAt: safeTimestamp(entry.firstLearnedAt),
            updatedAt: safeTimestamp(entry.updatedAt, safeTimestamp(entry.firstLearnedAt)),
            sourceCount: Math.max(0, Math.trunc(Number(entry.sourceCount) || 0)),
            ...(entry.tag ? { tag: boundedText(entry.tag, 200) } : {}),
        })),
        updatedAt: safeTimestamp(plate.updatedAt),
        version: Math.max(0, Math.trunc(Number(plate.version) || 0)),
    }));
    const links = input.links.map(link => ({
        id: boundedText(link.id, 200),
        sourceId: boundedText(link.sourceId, 200),
        targetId: boundedText(link.targetId, 200),
        type: link.type,
        strength: Math.max(0, Math.min(1, Number(link.strength) || 0)),
    }));
    const anticipations = input.anticipations.map(anticipation => ({
        id: boundedText(anticipation.id, 200),
        content: boundedText(anticipation.content, 190_000, '[空期盼]') || '[空期盼]',
        status: anticipation.status,
        createdAt: safeTimestamp(anticipation.createdAt),
        anchoredAt: anticipation.anchoredAt == null ? null : safeTimestamp(anticipation.anchoredAt),
        resolvedAt: anticipation.resolvedAt == null ? null : safeTimestamp(anticipation.resolvedAt),
    }));
    const normalizeSections = (sections: DigestReport['examined']) => (sections || []).slice(0, 1_000).map(section => ({
        label: boundedText(section.label, 500),
        items: (section.items || []).slice(0, 1_000).map(item => boundedText(item, 20_000)),
    }));
    const digestReports = input.digestReports.map(report => ({
        id: boundedText(report.id, 200),
        createdAt: safeTimestamp(report.createdAt),
        trigger: report.trigger === 'manual' ? 'manual' as const : 'auto' as const,
        examined: normalizeSections(report.examined),
        outcomes: normalizeSections(report.outcomes),
        plateSubmissions: normalizeSections(report.plateSubmissions),
        plateUpdated: (report.plateUpdated || []).slice(0, 100),
    }));
    const vectors = input.vectors.map(mapVector);
    const batches = input.batches.map(batch => ({
        id: boundedText(batch.id, 200),
        eventBoxId: batch.boxId ? boundedText(batch.boxId, 200) : null,
        status: batch.status,
        nodesCreated: Math.max(0, Math.trunc(Number(batch.nodesCreated) || 0)),
        error: batch.error == null ? null : boundedText(batch.error, 20_000),
        createdAt: safeTimestamp(batch.createdAt),
        completedAt: batch.completedAt == null ? null : safeTimestamp(batch.completedAt),
    }));
    const topicBoxes = input.topicBoxes.map(box => ({
        id: boundedText(box.id, 200),
        messageIds: (box.messageIds || []).slice(0, 100_000).map(value => safeTimestamp(value)),
        status: box.status,
        topic: boundedText(box.topic, 20_000),
        events: (box.events || []).slice(0, 10_000).map(value => boundedText(value, 20_000)),
        keywords: (box.keywords || []).slice(0, 10_000).map(value => boundedText(value, 500)),
        createdAt: safeTimestamp(box.createdAt),
        sealedAt: box.sealedAt == null ? null : safeTimestamp(box.sealedAt),
    }));

    const rounds = Math.max(
        1,
        Math.ceil(eventBoxes.length / 100),
        Math.ceil(roomPlates.length / 50),
        Math.ceil(links.length / 1_000),
        Math.ceil(anticipations.length / 500),
        Math.ceil(digestReports.length / 100),
        Math.ceil(vectors.length / 100),
        Math.ceil(batches.length / 1_000),
        Math.ceil(topicBoxes.length / 1_000),
    );
    for (let index = 0; index < rounds; index += 1) {
        await backendFetch(input.config, '/v1/memory-palace/sync', {
            method: 'POST',
            body: JSON.stringify({
                clientId: getClientId(),
                characterId: input.characterId,
                snapshotId: input.snapshotId,
                eventBoxes: eventBoxes.slice(index * 100, (index + 1) * 100),
                roomPlates: roomPlates.slice(index * 50, (index + 1) * 50),
                links: links.slice(index * 1_000, (index + 1) * 1_000),
                anticipations: anticipations.slice(index * 500, (index + 1) * 500),
                digestReports: digestReports.slice(index * 100, (index + 1) * 100),
                vectors: vectors.slice(index * 100, (index + 1) * 100),
                batches: batches.slice(index * 1_000, (index + 1) * 1_000),
                topicBoxes: topicBoxes.slice(index * 1_000, (index + 1) * 1_000),
            }),
        });
        input.onProgress?.(index + 1, rounds);
    }
    await backendFetch(input.config, '/v1/memory-palace/reconcile', {
        method: 'POST',
        body: JSON.stringify({
            characterId: input.characterId,
            snapshotId: input.snapshotId,
        }),
    });
    const stats = await backendFetch(
        input.config,
        `/v1/memory-palace/${encodeURIComponent(input.characterId)}/stats`,
    );
    return {
        eventBoxes: eventBoxes.length,
        roomPlates: roomPlates.length,
        links: links.length,
        anticipations: anticipations.length,
        digestReports: digestReports.length,
        vectors: vectors.length,
        batches: batches.length,
        topicBoxes: topicBoxes.length,
        backendCounts: stats.data || {},
    };
}

function queuedPayloads<T>(changes: BackendMemoryChange[], entityType: BackendMemoryChange['entityType']): T[] {
    return changes
        .filter(change => change.entityType === entityType && change.operation === 'upsert' && change.payload)
        .map(change => change.payload as T);
}

/**
 * 把 Memory Palace 的本地变更队列增量推到后端。队列只有在两类接口都成功后才确认，
 * 所以中途断网时下轮会安全重试；所有后端 upsert/delete 都是幂等的。
 */
export async function flushBackendMemorySyncQueue(input: {
    config: BackendChatConfig;
    character: CharacterProfile;
    user: UserProfile;
    priorityDeletedMessageIds?: number[];
    priorityDeletedEventIds?: string[];
}): Promise<{ synced: number }> {
    const priorityKeys = [
        ...(input.priorityDeletedMessageIds || []).map(id => `${input.character.id}:chat_message:${id}`),
        ...(input.priorityDeletedEventIds || []).map(id => `${input.character.id}:backend_event:${id}`),
    ];
    const [priorityChanges, regularChanges] = await Promise.all([
        getBackendMemoryChangesByKeys(input.character.id, priorityKeys),
        getBackendMemoryChanges(input.character.id, 200),
    ]);
    const changes = [...new Map([...priorityChanges, ...regularChanges].map(change => [change.key, change])).values()];
    if (changes.length === 0) return { synced: 0 };

    const nodeUpserts = queuedPayloads<MemoryNode>(changes, 'memory_node');
    const nodeDeletes = changes
        .filter(change => change.entityType === 'memory_node' && change.operation === 'delete')
        .map(change => change.entityId);
    const messageDeletes = changes
        .filter(change => change.entityType === 'chat_message' && change.operation === 'delete')
        .map(change => Number(change.entityId))
        .filter(value => Number.isSafeInteger(value) && value >= 0);
    const backendEventDeletes = changes
        .filter(change => change.entityType === 'backend_event' && change.operation === 'delete')
        .map(change => change.entityId);
    if (nodeUpserts.length > 0 || nodeDeletes.length > 0 || messageDeletes.length > 0 || backendEventDeletes.length > 0) {
        await syncBackendContext({
            config: input.config,
            character: input.character,
            user: input.user,
            messages: [],
            memories: nodeUpserts,
            deletedMessageIds: messageDeletes,
            deletedEventIds: backendEventDeletes,
            deletedMemoryIds: nodeDeletes,
        });
    }

    const eventBoxes = queuedPayloads<EventBox>(changes, 'event_box').map(box => ({
        id: boundedText(box.id, 200),
        name: boundedText(box.name, 2_000),
        tags: (box.tags || []).slice(0, 200).map(tag => boundedText(tag, 200)),
        summaryNodeId: box.summaryNodeId ? boundedText(box.summaryNodeId, 200) : null,
        liveMemoryIds: (box.liveMemoryIds || []).slice(0, 10_000).map(value => boundedText(value, 200)),
        archivedMemoryIds: (box.archivedMemoryIds || []).slice(0, 50_000).map(value => boundedText(value, 200)),
        compressionCount: Math.max(0, Math.trunc(Number(box.compressionCount) || 0)),
        createdAt: safeTimestamp(box.createdAt),
        updatedAt: safeTimestamp(box.updatedAt, safeTimestamp(box.createdAt)),
        lastCompressedAt: box.lastCompressedAt == null ? null : safeTimestamp(box.lastCompressedAt),
        sealed: box.sealed === true,
        predecessorBoxId: box.predecessorBoxId ? boundedText(box.predecessorBoxId, 200) : null,
    }));
    const roomPlates = queuedPayloads<RoomPlate>(changes, 'room_plate').map(plate => ({
        id: boundedText(plate.id, 200),
        room: plate.room,
        entries: (plate.entries || []).slice(0, 500).map((entry, index) => ({
            id: boundedText(entry.id, 200, `plate-entry-${index}`) || `plate-entry-${index}`,
            text: boundedText(entry.text, 10_000, '[空门牌条目]') || '[空门牌条目]',
            firstLearnedAt: safeTimestamp(entry.firstLearnedAt),
            updatedAt: safeTimestamp(entry.updatedAt, safeTimestamp(entry.firstLearnedAt)),
            sourceCount: Math.max(0, Math.trunc(Number(entry.sourceCount) || 0)),
            ...(entry.tag ? { tag: boundedText(entry.tag, 200) } : {}),
        })),
        updatedAt: safeTimestamp(plate.updatedAt),
        version: Math.max(0, Math.trunc(Number(plate.version) || 0)),
    }));
    const links = queuedPayloads<MemoryLink>(changes, 'memory_link').map(link => ({
        id: boundedText(link.id, 200),
        sourceId: boundedText(link.sourceId, 200),
        targetId: boundedText(link.targetId, 200),
        type: link.type,
        strength: Math.max(0, Math.min(1, Number(link.strength) || 0)),
    }));
    const anticipations = queuedPayloads<Anticipation>(changes, 'anticipation').map(anticipation => ({
        id: boundedText(anticipation.id, 200),
        content: boundedText(anticipation.content, 190_000, '[空期盼]') || '[空期盼]',
        status: anticipation.status,
        createdAt: safeTimestamp(anticipation.createdAt),
        anchoredAt: anticipation.anchoredAt == null ? null : safeTimestamp(anticipation.anchoredAt),
        resolvedAt: anticipation.resolvedAt == null ? null : safeTimestamp(anticipation.resolvedAt),
    }));
    const normalizeSections = (sections: DigestReport['examined']) => (sections || []).slice(0, 1_000).map(section => ({
        label: boundedText(section.label, 500),
        items: (section.items || []).slice(0, 1_000).map(item => boundedText(item, 20_000)),
    }));
    const digestReports = queuedPayloads<DigestReport>(changes, 'digest_report').map(report => ({
        id: boundedText(report.id, 200),
        createdAt: safeTimestamp(report.createdAt),
        trigger: report.trigger === 'manual' ? 'manual' as const : 'auto' as const,
        examined: normalizeSections(report.examined),
        outcomes: normalizeSections(report.outcomes),
        plateSubmissions: normalizeSections(report.plateSubmissions),
        plateUpdated: (report.plateUpdated || []).slice(0, 100),
    }));
    const vectors = queuedPayloads<MemoryVector>(changes, 'memory_vector').map(mapVector);
    const batches = queuedPayloads<MemoryBatch>(changes, 'memory_batch').map(batch => ({
        id: boundedText(batch.id, 200),
        eventBoxId: batch.boxId ? boundedText(batch.boxId, 200) : null,
        status: batch.status,
        nodesCreated: Math.max(0, Math.trunc(Number(batch.nodesCreated) || 0)),
        error: batch.error == null ? null : boundedText(batch.error, 20_000),
        createdAt: safeTimestamp(batch.createdAt),
        completedAt: batch.completedAt == null ? null : safeTimestamp(batch.completedAt),
    }));
    const topicBoxes = queuedPayloads<TopicBox>(changes, 'topic_box').map(box => ({
        id: boundedText(box.id, 200),
        messageIds: (box.messageIds || []).slice(0, 100_000).map(value => safeTimestamp(value)),
        status: box.status,
        topic: boundedText(box.topic, 20_000),
        events: (box.events || []).slice(0, 10_000).map(value => boundedText(value, 20_000)),
        keywords: (box.keywords || []).slice(0, 10_000).map(value => boundedText(value, 500)),
        createdAt: safeTimestamp(box.createdAt),
        sealedAt: box.sealedAt == null ? null : safeTimestamp(box.sealedAt),
    }));

    const deletionIds = (entityType: BackendMemoryChange['entityType']) => changes
        .filter(change => change.entityType === entityType && change.operation === 'delete')
        .map(change => boundedText(change.entityId, 200));
    const palaceChangeCount = eventBoxes.length + roomPlates.length + links.length + anticipations.length
        + digestReports.length + vectors.length + batches.length + topicBoxes.length
        + changes.filter(change => change.operation === 'delete'
            && !['memory_node', 'chat_message', 'backend_event'].includes(change.entityType)).length;
    if (palaceChangeCount > 0) {
        await backendFetch(input.config, '/v1/memory-palace/sync', {
            method: 'POST',
            body: JSON.stringify({
                clientId: getClientId(),
                characterId: input.character.id,
                eventBoxes,
                roomPlates,
                links,
                anticipations,
                digestReports,
                vectors,
                batches,
                topicBoxes,
                deletions: {
                    eventBoxIds: deletionIds('event_box'),
                    roomPlateIds: deletionIds('room_plate'),
                    linkIds: deletionIds('memory_link'),
                    anticipationIds: deletionIds('anticipation'),
                    digestReportIds: deletionIds('digest_report'),
                    vectorMemoryIds: deletionIds('memory_vector'),
                    batchIds: deletionIds('memory_batch'),
                    topicBoxIds: deletionIds('topic_box'),
                },
            }),
        });
    }

    await acknowledgeBackendMemoryChanges(changes);
    return { synced: changes.length };
}

export async function requestBackendChatTurn(input: {
    config: BackendChatConfig;
    characterId: string;
    promptMessages?: Array<{ role: string; content: any; [key: string]: any }>;
    contextMode?: 'frontend_snapshot' | 'server_native';
    userMessage?: string;
    temperature?: number;
    maxTokens?: number;
}): Promise<any> {
    const requestId = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await backendFetch(input.config, '/v1/chat/turn', {
        method: 'POST',
        body: JSON.stringify({
            requestId,
            characterId: input.characterId,
            contextMode: input.contextMode ?? 'frontend_snapshot',
            ...(input.promptMessages ? { promptMessages: input.promptMessages } : {}),
            ...(input.userMessage ? { userMessage: input.userMessage } : {}),
            temperature: input.temperature,
            maxTokens: input.maxTokens,
        }),
    });
    return {
        ...(result?.data || {}),
        _sullyBackendEventId: result?.event?.id,
    };
}

interface BackendEventApiRow {
    sequence_id: string | number;
    id: string;
    conversation_id: string;
    character_id: string;
    character_name?: string | null;
    actor_type: BackendConversationEventRecord['actorType'];
    event_type: BackendConversationEventType;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    occurred_at: string;
    created_at: string;
}

function parseEventSequence(value: string | number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`后端事件序号无效：${String(value)}`);
    }
    return parsed;
}

export async function getBackendEventCursor(config: BackendChatConfig): Promise<number> {
    const result = await backendFetch(config, '/v1/events/cursor');
    return parseEventSequence(result?.data?.sequenceId ?? 0);
}

export async function getBackendEvents(
    config: BackendChatConfig,
    afterSequence: number,
    limit = 200,
): Promise<BackendConversationEventRecord[]> {
    const result = await backendFetch(
        config,
        `/v1/events?afterSequence=${encodeURIComponent(String(afterSequence))}&limit=${Math.max(1, Math.min(200, limit))}`,
    );
    const rows = Array.isArray(result?.data) ? result.data as BackendEventApiRow[] : [];
    return rows.map(row => ({
        id: row.id,
        sequenceId: parseEventSequence(row.sequence_id),
        conversationId: row.conversation_id,
        charId: row.character_id,
        ...(row.character_name ? { charName: row.character_name } : {}),
        actorType: row.actor_type,
        eventType: row.event_type,
        content: typeof row.content === 'string' ? row.content : null,
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
        receivedAt: Date.now(),
    }));
}

export async function syncBackendDiary(
    config: BackendChatConfig,
    input: {
        characterId: string;
        clientDiaryId: string;
        authorType: 'user' | 'assistant';
        title: string;
        content: string;
        diaryDate: string;
        paperStyle: string;
        metadata?: Record<string, unknown>;
    },
): Promise<BackendDiary> {
    const result = await backendFetch(config, '/v1/diaries/sync', {
        method: 'POST',
        body: JSON.stringify(input),
    });
    return result.data as BackendDiary;
}

export async function getBackendDiaries(
    config: BackendChatConfig,
    characterId: string,
    limit = 100,
): Promise<BackendDiary[]> {
    const result = await backendFetch(
        config,
        `/v1/diaries?characterId=${encodeURIComponent(characterId)}&limit=${Math.max(1, Math.min(200, limit))}`,
    );
    return Array.isArray(result?.data) ? result.data as BackendDiary[] : [];
}

export async function deleteBackendDiary(
    config: BackendChatConfig,
    diaryId: string,
): Promise<void> {
    await backendFetch(config, '/v1/diaries/' + encodeURIComponent(diaryId), {
        method: 'DELETE',
    });
}

export async function generateBackendCharacterDiary(
    config: BackendChatConfig,
    characterId: string,
    instruction?: string,
): Promise<BackendDiary> {
    const result = await backendFetch(config, '/v1/diaries/generate', {
        method: 'POST',
        body: JSON.stringify({ characterId, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}) }),
    });
    return result.data as BackendDiary;
}

export async function addBackendDiaryComment(
    config: BackendChatConfig,
    diaryId: string,
    input: {
        clientCommentId: string;
        content: string;
        replyToId?: string | null;
        metadata?: Record<string, unknown>;
    },
): Promise<BackendDiaryComment> {
    const result = await backendFetch(config, `/v1/diaries/${encodeURIComponent(diaryId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
    });
    return result.data as BackendDiaryComment;
}

export async function requestBackendDiaryCommentResponse(
    config: BackendChatConfig,
    diaryId: string,
): Promise<BackendDiaryComment> {
    const result = await backendFetch(
        config,
        `/v1/diaries/${encodeURIComponent(diaryId)}/comments/respond`,
        { method: 'POST', body: JSON.stringify({}) },
    );
    return result.data as BackendDiaryComment;
}
