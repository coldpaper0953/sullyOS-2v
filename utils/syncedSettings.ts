/**
 * 设置项的逐键云同步（sully_settings 表）。
 *
 * 为什么另起一层，而不是继续用 cloudSync 的整包：
 * 整包同步把所有设置压成一个 zip / 一个加密信封，上传时**整行替换**云端。包是从 React
 * state 取的，某些字段还没加载完就触发上传时，打出来的包会静默少几项——然后把上一次同步
 * 好的字段一起抹掉。实测云端 9 项只剩 5 项（apiPresets / availableModels /
 * instantPushConfig / studyApiConfig 全丢），用户侧表现就是「新加的预设怎么都同步不过去」。
 *
 * 这一层改成**一个键一行**：只可能覆盖确实写了的那个键，没写的键动都不会动。
 * 每行自带 updated_at，天然就是「按最新时间覆盖」。
 *
 * 分工：设置/密钥这类小而碎的键走这里；角色、聊天、记忆宫殿这些重数据仍走 cloudSync 的
 * zip 包（几十 MB 的向量塞不进 key/value 表，也会撑爆免费额度）。
 */

import type { CloudSyncConfig, CloudSyncSession } from './cloudSync';

/** 参与同步的 localStorage 键。sensitive=true 的值加密后才上云。 */
export const SYNCED_SETTING_KEYS: ReadonlyArray<{ key: string; sensitive: boolean }> = [
    { key: 'os_api_config', sensitive: true },
    { key: 'os_api_presets', sensitive: true },
    { key: 'os_available_models', sensitive: false },
    { key: 'sullyos_api_failover_v1', sensitive: false },
    { key: 'push_vapid_v1', sensitive: true },
    { key: 'instant_push_config_v1', sensitive: true },
    { key: 'study_api_config', sensitive: true },
];

const SENSITIVE = new Set(SYNCED_SETTING_KEYS.filter(k => k.sensitive).map(k => k.key));
const ALL_KEYS = new Set(SYNCED_SETTING_KEYS.map(k => k.key));

/** 防抖窗口：连续改动只在停手后统一发一次请求。 */
const DEBOUNCE_MS = 1200;

const TABLE = 'sully_settings';

let dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let stopWatch: (() => void) | null = null;

/** 由 OSContext 在登录态就绪后注入，拿不到就说明没登录——静默跳过所有同步。 */
let resolveCtx: (() => { config: CloudSyncConfig; session: CloudSyncSession; key: CryptoKey | null } | null) | null = null;

export function bindSyncedSettingsContext(fn: typeof resolveCtx): void {
    resolveCtx = fn;
}

export function isSyncedSettingKey(key: string): boolean {
    return ALL_KEYS.has(key);
}

// ── 加密：敏感值用与 cloudSync 同一把派生密钥（AES-256-GCM），信封是紧凑的 iv:ct ──

const b64e = (b: ArrayBuffer | Uint8Array): string => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
};
const b64d = (s: string): ArrayBuffer => {
    const u = Uint8Array.from(atob(s), c => c.charCodeAt(0));
    // 复制成独立 ArrayBuffer：WebCrypto 的 BufferSource 在当前 tsconfig 下不吃带偏移的视图
    return u.slice().buffer as ArrayBuffer;
};

const ENC_PREFIX = 'SEC1:';

async function sealValue(key: CryptoKey, plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return `${ENC_PREFIX}${b64e(iv)}:${b64e(ct)}`;
}

async function openValue(key: CryptoKey, stored: string): Promise<string | null> {
    if (!stored.startsWith(ENC_PREFIX)) return stored; // 兼容早期未加密写入
    const [, ivB64, ctB64] = stored.split(':');
    if (!ivB64 || !ctB64) return null;
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) }, key, b64d(ctB64));
        return new TextDecoder().decode(plain);
    } catch {
        return null; // 换过密码 → 解不开就跳过这一项，不要让整轮拉取失败
    }
}

function restBase(config: CloudSyncConfig): string {
    return `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${TABLE}`;
}

function headers(config: CloudSyncConfig, session: CloudSyncSession): Record<string, string> {
    return {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
    };
}

/**
 * 开机拉取：把云端所有设置行灌回 localStorage。
 *
 * 必须在读这些键的代码（OSContext 的初始化）之前 await 掉，否则会出现「界面先用旧值渲染、
 * 数据后到」——那正是整包同步时代「改了又变回去」的观感来源。
 *
 * 返回实际写回的键数；未登录 / 无网络时返回 0，绝不抛错（本地必须能照常用）。
 */
export async function pullSyncedSettings(): Promise<number> {
    const ctx = resolveCtx?.();
    if (!ctx) return 0;
    const { config, session, key } = ctx;
    try {
        const res = await fetch(`${restBase(config)}?select=key,value,encrypted,updated_at`, {
            headers: headers(config, session),
        });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ key: string; value: string | null; encrypted: boolean }>;
        let applied = 0;
        for (const row of rows) {
            if (!ALL_KEYS.has(row.key) || row.value == null) continue;
            let plain: string | null = row.value;
            if (row.encrypted) {
                if (!key) continue; // 没有密钥就跳过敏感项，普通项照样落地
                plain = await openValue(key, row.value);
            }
            if (plain == null) continue;
            try {
                localStorage.setItem(row.key, plain);
                applied++;
            } catch { /* 存储被禁用 */ }
        }
        return applied;
    } catch {
        return 0;
    }
}

/**
 * 标记某个键有改动。写 localStorage 由调用方负责（界面要零延迟），这里只管上云。
 * 1.2 秒内的连续改动合并成一次请求；期间又有新改动就重新计时。
 */
export function markSyncedSettingDirty(key: string): void {
    if (!ALL_KEYS.has(key)) return;
    dirty.add(key);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flushSyncedSettings(); }, DEBOUNCE_MS);
}

/** 立刻把攒下的改动推上去（页面即将关闭、或用户手动点同步时用）。 */
export async function flushSyncedSettings(): Promise<number> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (flushing || dirty.size === 0) return 0;
    const ctx = resolveCtx?.();
    if (!ctx) { dirty.clear(); return 0; }
    const { config, session, key } = ctx;

    const pending = Array.from(dirty);
    dirty = new Set();
    flushing = true;
    try {
        const now = Date.now();
        const rows: Array<Record<string, unknown>> = [];
        const userId = session.userId;
        for (const k of pending) {
            const raw = localStorage.getItem(k);
            if (raw == null) continue; // 删除语义单独走 deleteSyncedSetting
            const sensitive = SENSITIVE.has(k);
            if (sensitive && !key) continue; // 拿不到密钥宁可不传，也不明文上云
            rows.push({
                user_id: userId,
                key: k,
                value: sensitive && key ? await sealValue(key, raw) : raw,
                encrypted: sensitive,
                updated_at: now,
            });
        }
        if (rows.length === 0) return 0;
        const res = await fetch(restBase(config), {
            method: 'POST',
            headers: { ...headers(config, session), Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows),
        });
        if (!res.ok) {
            pending.forEach(k => dirty.add(k)); // 失败的放回去，下次再试
            return 0;
        }
        return rows.length;
    } catch {
        pending.forEach(k => dirty.add(k));
        return 0;
    } finally {
        flushing = false;
    }
}

/**
 * 首轮播种：云端没有某个键、而本机有值，就把本机这份推上去。
 *
 * 没有这一步的话，新表会一直是空的——只有用户主动改过某项设置才会产生行，
 * 其他设备刷新永远拉不到东西（用户报的「其他浏览器没同步上」就是这个）。
 * 只补云端缺的键，已存在的行一律不动（那可能是别的设备刚写的、更新的值）。
 */
export async function seedSyncedSettings(): Promise<number> {
    const ctx = resolveCtx?.();
    if (!ctx) return 0;
    try {
        const res = await fetch(`${restBase(ctx.config)}?select=key`, { headers: headers(ctx.config, ctx.session) });
        if (!res.ok) return 0;
        const have = new Set((await res.json() as Array<{ key: string }>).map(r => r.key));
        let queued = 0;
        for (const { key } of SYNCED_SETTING_KEYS) {
            if (have.has(key)) continue;
            if (localStorage.getItem(key) == null) continue;
            dirty.add(key);
            queued++;
        }
        if (queued === 0) return 0;
        return await flushSyncedSettings();
    } catch {
        return 0;
    }
}

/**
 * 不用重启也能同步：页面回到前台 / 重新获得焦点时补拉一次（20 秒内不重复拉）。
 *
 * 用户的原话是「能不能不要重启的同步」——开机拉一次不够，换设备改完再切回来，
 * 这台得自己发现。返回取消监听的函数，交给 OSContext 的清理逻辑。
 */
export function startSyncedSettingsWatch(onApplied?: (n: number) => void): () => void {
    if (stopWatch) return stopWatch; // 幂等：开机那条异步链可能跑多次，别叠监听
    let last = 0;
    const tick = () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - last < 20_000) return;
        last = now;
        void pullSyncedSettings().then(n => { if (n > 0) onApplied?.(n); });
    };
    const onVis = () => tick();
    const onFocus = () => tick();
    // 页面即将隐藏时把攒着的改动立刻推走，别等那 1.2 秒的防抖（可能等不到）
    const onHide = () => { void flushSyncedSettings(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    if (typeof window !== 'undefined') {
        window.addEventListener('focus', onFocus);
        window.addEventListener('pagehide', onHide);
    }
    return () => {
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        if (typeof window !== 'undefined') {
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('pagehide', onHide);
        }
        stopWatch = null;
    };
}

/** 删除一个设置键（本地已删，云端也要删，否则下次开机又被拉回来）。 */
export async function deleteSyncedSetting(key: string): Promise<void> {
    if (!ALL_KEYS.has(key)) return;
    const ctx = resolveCtx?.();
    if (!ctx) return;
    dirty.delete(key);
    try {
        await fetch(`${restBase(ctx.config)}?key=eq.${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: { ...headers(ctx.config, ctx.session), Prefer: 'return=minimal' },
        });
    } catch { /* 下次开机会被云端值覆盖，不致命 */ }
}
