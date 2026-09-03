/**
 * Supabase 云端账号同步（GitHub Pages 部署形态）
 *
 * 用户旅程：注册一个账号（邮箱+密码）→ 本机全部数据（角色、聊天、设置、
 * API 配置……即「设置 → 导出备份」同一口径的全量 JSON）推到自己的
 * Supabase 项目 → 换设备登录同一账号 → 一键拉回，无缝继续。
 *
 * 与已有「云端备份」（WebDAV / GitHub Releases 文件式）和「自主后端」
 * （Fastify）并存：那条链路是手动文件，这条是账号制实时键值——
 * 各服务各场景，不互斥。
 *
 * 实现约束：
 * - 零依赖：原生 fetch 调 Supabase Auth REST（/auth/v1/*）+ PostgREST
 *   （/rest/v1/*），与 utils/memoryPalace/supabaseVector.ts 同范式。
 * - RLS 行级安全：数据行 owner = auth.uid()，登录拿到的 JWT 才能读写
 *   自己的行；anon key 拿不到任何人的数据（比向量表的全开策略更严）。
 * - 压缩：浏览器原生 CompressionStream('gzip') 无损压缩全量 JSON
 *   （聊天记录这类重复文本压缩率常 5-10×），列存 base64 文本。
 *   接近套餐上限（如 400MB）时 push 前给出明确警告——不引入有损的
 *   LLM 压缩，聊天记录逐字不可再生，有损压缩后无法还原。
 * - 心跳：pg_cron 每 30 分钟 touch 一次 heartbeat 表。免费项目「7 天
 *   无活动会暂停」，心跳顺带保活；同步数据时也会顺带 touch。
 *
 * 数据归属：100% 在用户自己的 Supabase 项目。
 */

import { MIRRORED_KEYS } from './lsMirror';

// ─── 初始化 SQL（用户需在 Supabase SQL Editor 运行一次）───────────

export const CLOUD_SYNC_INIT_SQL = `
-- ═══ SullyOS 云端账号同步 · 初始化（一次性，幂等可重跑） ═══

-- 1. 账号数据快照表：一行 = 一个账号的最新全量备份（gzip base64 文本）
create table if not exists sully_user_data (
  user_id uuid primary key,                    -- = auth.users.id
  gzip_b64 text not null default '',            -- FullBackupData JSON 的 gzip + base64
  raw_bytes bigint not null default 0,         -- 压缩前 JSON 字节数（配额预警用）
  gzip_bytes bigint not null default 0,       -- 压缩后字节数
  snapshot_version int not null default 1,    -- 备份格式版本
  device_label text not null default '',       -- 最后上传设备标识（多设备提示用）
  pushed_at bigint not null default 0,        -- 最后上传时间（epoch ms）
  pulled_at bigint not null default 0          -- 最后下载时间（epoch ms）
);

-- 2. 心跳表：pg_cron 定时 touch，防免费项目 7 天无活动被暂停
create table if not exists sully_heartbeat (
  id int primary key default 1,
  beat_at bigint not null default 0
);
insert into sully_heartbeat (id, beat_at)
values (1, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set beat_at = (extract(epoch from now()) * 1000)::bigint;

-- 3.5 API 密钥等敏感字段（可选加密）：整包明文备份里已剥掉这些字段，
--      它们单独加密（账号密码派生密钥）后存这张表。不推密钥 = 表里没行，
--      换设备拉明文数据照常，只是 API 密钥不自动跟随。
create table if not exists sully_api_secrets (
  user_id uuid primary key,
  envelope text not null default '',             -- CipherEnvelope JSON（PBKDF2+AES-GCM）
  pushed_at bigint not null default 0
);
alter table sully_api_secrets enable row level security;
drop policy if exists " own secrets only " on sully_api_secrets;
create policy " own secrets only " on sully_api_secrets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3. 行级安全：只有登录用户本人能动自己的行
alter table sully_user_data enable row level security;
drop policy if exists " own row only " on sully_user_data;
create policy " own row only " on sully_user_data
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table sully_heartbeat enable row level security;
drop policy if exists " anyone can beat " on sully_heartbeat;
-- 心跳由 pg_cron 以服务角色跑（绕过 RLS），客户端只需可读状态 + 登录后可 touch
create policy " readable by authenticated " on sully_heartbeat
  for select using (true);
create policy " beat by authenticated " on sully_heartbeat
  for update using (true) with check (true);

-- 4. pg_cron 心跳调度（免费版可用；若项目不支持会静默跳过，不影响同步本身）
--    每 30 分钟 touch 一行。已存在同任务时不重复建。
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform 1 from cron.job where jobid::text = (
      select jobid::text from cron.job where schedule = '*/30 * * * *' and command = 'update sully_heartbeat set beat_at = (extract(epoch from now()) * 1000)::bigint where id = 1' limit 1
    ) limit 1;
    if not found then
      perform cron.schedule(
        'sully-heartbeat',
        '*/30 * * * *',
        'update sully_heartbeat set beat_at = (extract(epoch from now()) * 1000)::bigint where id = 1'
      );
    end if;
  end if;
end $$;
`.trim();

// ─── 本地配置（localStorage，组件直管，不进 OSContext） ────────────

const LS_CONFIG = 'os_cloud_sync_config_v1';
const LS_SESSION = 'os_cloud_sync_session_v1';

export interface CloudSyncConfig {
    supabaseUrl: string;      // e.g. https://xxxx.supabase.co
    supabaseAnonKey: string;
    autoSync: boolean;        // 登录状态下每次页面隐藏时自动 push
}

export interface CloudSyncSession {
    accessToken: string;
    refreshToken: string;
    userId: string;
    email: string;
    expiresAt: number;       // epoch ms
}

/**
 * 官方内置服务器：用户不用自己注册 Supabase / 跑初始化 SQL——
 * 打开面板直接邮箱+密码注册登录即可，数据同样按账号行级隔离（RLS）。
 * 曾部署过的老用户（localStorage 里已有自己的地址）不受影响，配置仍然生效。
 */
const BUILTIN_CLOUD: Pick<CloudSyncConfig, 'supabaseUrl' | 'supabaseAnonKey'> = {
    supabaseUrl: 'https://lnhwnmylxmythvttosla.supabase.co',
    supabaseAnonKey: 'sb_publishable_xsbSxvRKhNt8gYrejRiQYg_h9jsPD56',
};

export function loadCloudSyncConfig(): CloudSyncConfig {
    try {
        const raw = localStorage.getItem(LS_CONFIG);
        if (!raw) {
            // 没有历史配置 → 直接用内置官方服务器（anon key 是发布键，
            // 设计上就随前端分发，不算秘密；数据行仍只允许登录用户本人读写）。
            // autoSync 默认开：用户要的是「点开就是上次的状态」，不该再手动开开关。
            return { ...BUILTIN_CLOUD, autoSync: true };
        }
        const parsed = JSON.parse(raw) as Partial<CloudSyncConfig>;
        return {
            supabaseUrl: (parsed.supabaseUrl || BUILTIN_CLOUD.supabaseUrl).trim(),
            supabaseAnonKey: (parsed.supabaseAnonKey || BUILTIN_CLOUD.supabaseAnonKey).trim(),
            // 老配置里没有这个字段（undefined）时按开处理；只有显式关过才是 false
            autoSync: parsed.autoSync !== false,
        };
    } catch {
        return { ...BUILTIN_CLOUD, autoSync: true };
    }
}

export function saveCloudSyncConfig(config: CloudSyncConfig): void {
    try {
        localStorage.setItem(LS_CONFIG, JSON.stringify({
            supabaseUrl: config.supabaseUrl.trim(),
            supabaseAnonKey: config.supabaseAnonKey.trim(),
            autoSync: config.autoSync === true,
        }));
    } catch { /* ignore */ }
}

export function loadCloudSyncSession(): CloudSyncSession | null {
    try {
        const raw = localStorage.getItem(LS_SESSION);
        if (!raw) return null;
        const s = JSON.parse(raw) as CloudSyncSession;
        if (!s?.accessToken || !s?.userId || !s.expiresAt) return null;
        return s;
    } catch {
        return null;
    }
}

export function saveCloudSyncSession(session: CloudSyncSession | null): void {
    try {
        if (!session) localStorage.removeItem(LS_SESSION);
        else localStorage.setItem(LS_SESSION, JSON.stringify(session));
    } catch { /* ignore */ }
}

// ─── REST helpers ──────────────────────────────────────────────────

function authHeaders(config: CloudSyncConfig, session: CloudSyncSession | null): Record<string, string> {
    const headers: Record<string, string> = {
        'apikey': config.supabaseAnonKey,
        'Content-Type': 'application/json',
    };
    // 数据行访问带用户 JWT（RLS 按 auth.uid() 放行）；anon 调用（注册登录）不带。
    if (session?.accessToken) headers['Authorization'] = `Bearer ${session.accessToken}`;
    return headers;
}

const baseUrl = (config: CloudSyncConfig) => config.supabaseUrl.replace(/\/+$/, '');

function assertConfig(config: CloudSyncConfig): void {
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error('请先填写 Supabase 项目地址和 anon key');
    }
}

export class CloudSyncApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

async function jsonOrThrow(res: Response, fallback: string): Promise<any> {
    let body: any = null;
    try { body = await res.json(); } catch { /* 非 JSON 错误页 */ }
    if (!res.ok) {
        const msg = body?.msg || body?.error_description || body?.error?.message || body?.message || body?.error || `${fallback}（HTTP ${res.status}）`;
        throw new CloudSyncApiError(String(msg), res.status);
    }
    return body;
}

// ─── 认证（Supabase Auth REST）─────────────────────────────────────

export async function cloudSyncSignUp(config: CloudSyncConfig, email: string, password: string): Promise<CloudSyncSession> {
    assertConfig(config);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱格式不对');
    if (password.length < 6) throw new Error('密码至少 6 位');
    const res = await fetch(`${baseUrl(config)}/auth/v1/signup`, {
        method: 'POST',
        headers: authHeaders(config, null),
        body: JSON.stringify({ email, password }),
    });
    const body = await jsonOrThrow(res, '注册失败');
    // 部分项目开了「确认邮件」：此时无 session，需要用户去邮箱点链接后再回来登录。
    if (!body?.access_token) {
        throw new Error('注册成功，但项目开启了邮箱确认——请到邮箱点完确认链接，再回来登录');
    }
    const session: CloudSyncSession = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        userId: body.user?.id || '',
        email,
        expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
    };
    saveCloudSyncSession(session);
    return session;
}

export async function cloudSyncLogin(config: CloudSyncConfig, email: string, password: string): Promise<CloudSyncSession> {
    assertConfig(config);
    const res = await fetch(`${baseUrl(config)}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: authHeaders(config, null),
        body: JSON.stringify({ email, password }),
    });
    const body = await jsonOrThrow(res, '登录失败');
    const session: CloudSyncSession = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        userId: body.user?.id || '',
        email: body.email || email,
        expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
    };
    saveCloudSyncSession(session);
    return session;
}

/** access token 过期时用 refresh token 换新（自动同步链路里静默用）。 */
export async function cloudSyncRefresh(config: CloudSyncConfig, session: CloudSyncSession): Promise<CloudSyncSession | null> {
    if (session.expiresAt - Date.now() > 5 * 60_000) return session;
    if (!session.refreshToken) return null;
    try {
        const res = await fetch(`${baseUrl(config)}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: authHeaders(config, null),
            body: JSON.stringify({ refresh_token: session.refreshToken }),
        });
        const body = await jsonOrThrow(res, '会话续期失败');
        const next: CloudSyncSession = {
            accessToken: body.access_token,
            refreshToken: body.refresh_token || session.refreshToken,
            userId: body.user?.id || session.userId,
            email: session.email,
            expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
        };
        saveCloudSyncSession(next);
        return next;
    } catch {
        saveCloudSyncSession(null);
        return null;
    }
}

export function cloudSyncLogout(): void {
    saveCloudSyncSession(null);
}

/** 探测建表是否完成（不登录也能查：表不存在时 PostgREST 返回特定错误）。 */
export async function cloudSyncProbeTable(config: CloudSyncConfig): Promise<{ ok: boolean; message: string }> {
    assertConfig(config);
    try {
        const res = await fetch(`${baseUrl(config)}/rest/v1/sully_user_data?select=user_id&limit=1`, {
            headers: authHeaders(config, null),
        });
        // 建好表 + RLS：anon 查询返回 200 空数组或 401/403，都算「表存在」。
        if (res.ok) return { ok: true, message: '数据表已就绪' };
        // PostgREST: 表不存在 → 404 且 error code 42P01
        if (res.status === 404) return { ok: false, message: '还没建表：请在 Supabase SQL Editor 运行初始化 SQL' };
        return { ok: false, message: `表状态异常（HTTP ${res.status}）` };
    } catch (e) {
        return { ok: false, message: `连不上 Supabase：${e instanceof Error ? e.message : '网络错误'}` };
    }
}

// ─── gzip 无损压缩 / 解压（浏览器原生）─────────────────────────────

const GZIP_BROKEN = '此浏览器不支持 CompressionStream（gzip），无法同步';

async function gzipBytesToB64(input: Blob): Promise<{ gzipB64: string; gzipBytes: number }> {
    if (typeof CompressionStream === 'undefined') throw new Error(GZIP_BROKEN);
    const stream = input.stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK, buf.length)));
    }
    return { gzipB64: btoa(binary), gzipBytes: buf.length };
}

async function gunzipB64ToBytes(gzipB64: string): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') throw new Error(GZIP_BROKEN);
    const binary = atob(gzipB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// ─── 端到端加密（密码派生密钥 → AES-256-GCM 整包）─────────────────
//
// 威胁模型：攻击者拿到 Supabase 数据库内容（SQL 注入 / 服务商被拖库 / RLS 失守）
// 时，也读不出任何 API key 与聊天数据。密钥由用户密码 + 随机盐在浏览器里
// PBKDF2 派生，密码本身不上传、不落 localStorage、不进 session——登录
// fetch 一发完就只剩派生密钥在内存里，页面关掉即消失。
//
// 云端落库的是「密文信封」：盐 + GCM IV + 密文，全 base64。解密只需要
// 同一个密码。密码错 → GCM 校验位不匹配 → 直接报「密码不匹配」，
// 不会解出半截脏数据。

const PBKDF2_ITERATIONS = 210_000;
const MAGIC = 'SULLYE2E1'; // 信封版本号：将来升级算法时旧信封仍可识别

interface CipherEnvelope {
    magic: string;
    salt: string;  // base64
    iv: string;    // base64
    ct: string;    // base64（AES-256-GCM 密文 + 校验位）
}

async function deriveKey(password: string, saltBytes: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: saltBytes as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

function bytesToB64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** v1 兼容：旧版整包密文信封的解密路径（deriveKey/decryptEnvelope）仍保留，
 *  但不再有任何地方写入 v1 整包信封——新推送一律是「明文数据包 + v3 密钥信封」。 */

/** 信封解密回 zip Blob。密码不对时 GCM 校验失败，抛「密码不匹配」。 */
async function decryptEnvelope(password: string, env: CipherEnvelope): Promise<Blob> {
    if (env?.magic !== MAGIC) throw new Error('云端备份不是加密格式（可能是旧版未加密数据），请用旧版本拉回后重新上传');
    const key = await deriveKey(password, b64ToBytes(env.salt));
    let plain: ArrayBuffer;
    try {
        plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: b64ToBytes(env.iv) as unknown as BufferSource },
            key,
            b64ToBytes(env.ct) as unknown as BufferSource,
        );
    } catch {
        throw new Error('密码不匹配，无法解密云端备份');
    }
    return new Blob([plain], { type: 'application/zip' });
}

// ─── 密钥信封 v3：可复用的派生密钥（登录一次，之后每次打开自动解密）────
//
// v2 的问题：盐每次随机 → 派生密钥不能复用 → 每次刷新都得重输密码换算一次。
// 用户要的是「点开就是上次的状态，不用导入、不用输密码」，所以改成：
//   盐 = SHA-256(userId + 固定 pepper)（确定性，盐本来也不需要保密，
//   它的作用只是让同密码在不同账号下派生出不同密钥、挡彩虹表）
//   → 同一账号同一密码永远派生出同一把密钥
//   → 派生出来的 CryptoKey 以 **extractable:false** 存进本机 IndexedDB：
//     页面里能用它解密，但 JS 读不出密钥字节，密码本身依然不落任何存储。
// 云端仍只有密文（数据库被拖库读不出 API key）；本机被物理接触的场景下
// API key 本来就在 localStorage 里，存这把钥匙不额外降低安全性。
const SECRET_MAGIC = 'SULLYSEC3';
const SALT_PEPPER = 'sullyos-cloud-secrets-v3';
const LS_KEY_ASSET = 'cloud_secret_key_v3';

interface SecretEnvelope {
    magic: string;
    iv: string;
    ct: string;
}

async function deterministicSalt(userId: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId + SALT_PEPPER) as unknown as BufferSource);
    return new Uint8Array(digest);
}

/** 由账号密码 + 账号 id 派生可复用的密钥（不可导出）。 */
async function deriveReusableKey(password: string, userId: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveKey']);
    const salt = await deterministicSalt(userId);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false, // extractable:false —— 存进 IndexedDB 后 JS 也读不出密钥字节
        ['encrypt', 'decrypt'],
    );
}

/**
 * 拿到本账号可用的密钥：给了密码就派生并记住（登录/换密码时），
 * 没给就取本机记住的那把（平时打开页面走这条，全程无感）。
 * 都没有 → null（云端密钥这次拿不到，数据同步不受影响）。
 */
export async function resolveSecretKey(userId: string, password?: string): Promise<CryptoKey | null> {
    if (!userId) return null;
    if (password) {
        const key = await deriveReusableKey(password, userId);
        try {
            const { DB } = await import('./db');
            await DB.saveAssetRaw(LS_KEY_ASSET, { userId, key, savedAt: Date.now() });
        } catch { /* 存不下不影响本次使用 */ }
        return key;
    }
    try {
        const { DB } = await import('./db');
        const saved = await DB.getAssetRaw(LS_KEY_ASSET);
        if (saved?.userId === userId && saved.key instanceof CryptoKey) return saved.key;
    } catch { /* ignore */ }
    return null;
}

/** 忘掉本机记住的密钥（退出登录时调用）。 */
export async function forgetSecretKey(): Promise<void> {
    try {
        const { DB } = await import('./db');
        await DB.deleteAsset(LS_KEY_ASSET);
    } catch { /* ignore */ }
}

async function encryptSecrets(key: CryptoKey, json: string): Promise<SecretEnvelope> {
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: ivBytes as unknown as BufferSource },
        key,
        new TextEncoder().encode(json) as unknown as BufferSource,
    );
    return { magic: SECRET_MAGIC, iv: bytesToB64(ivBytes), ct: bytesToB64(new Uint8Array(ct)) };
}

/** 解密密钥信封。兼容 v2 旧信封（自带随机盐，必须有密码才能解）。 */
async function decryptSecrets(env: any, key: CryptoKey | null, password?: string): Promise<string> {
    if (env?.magic === SECRET_MAGIC) {
        if (!key) throw new Error('本机还没有解密钥匙');
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: b64ToBytes(env.iv) as unknown as BufferSource },
            key,
            b64ToBytes(env.ct) as unknown as BufferSource,
        );
        return new TextDecoder().decode(plain);
    }
    // v2 旧信封（magic SULLYE2E1 + 随机盐）：有密码就解，之后的推送会自动升级成 v3
    if (env?.magic === MAGIC) {
        if (!password) throw new Error('云端密钥是旧格式，需要账号密码升级一次');
        const blob = await decryptEnvelope(password, env as CipherEnvelope);
        return blob.text();
    }
    throw new Error('云端密钥格式无法识别');
}

// ─── 上传 / 恢复 ──────────────────────────────────────────────────

/**
 * 套餐配额预警阈值：gzip 后仍超过此字节数就提示（默认按免费 500MB 留 100MB 余量）。
 * 注意云同步存的是 text_only 档 zip（无媒体二进制，聊天里的图片是 blobref 令牌），
 * 实际体积 = 压缩后的文本，通常只有几 MB；到这个阈值说明文本本身已经极庞大。
 */
export const QUOTA_WARN_BYTES = 400 * 1024 * 1024;

export interface PushOptions {
    /** 「设置 → 导出备份」text_only 档的 zip Blob（调用方经 exportSystem 生成，含 API 配置等全部设置）。 */
    zipBlob: Blob;
    /** 敏感字段（API 配置等）的明文 JSON 字符串——存进 zip 前已从中剥出；单独加密上传。 */
    secretsJson?: string;
    deviceLabel?: string;
    onProgress?: (msg: string) => void;
    /**
     * 敏感字段的加密密钥（resolveSecretKey 拿到的可复用密钥）。没有 = 跳过密钥上传
     * （明文数据照常推）。v3 架构：普通数据（角色/聊天/设置）明文同步（RLS 行级隔离，
     * 只有本人可读），只有 API 密钥这批敏感字段加密后另存一张表。
     */
    secretKey?: CryptoKey | null;
}

/**
 * zip 里属于「敏感字段」的顶层键：从明文包里剥出来（推到 sully_api_secrets 前），
 * 恢复时再合并回去。名单 = FullBackupData 里含 API key / token 的字段。
 */
export const SECRET_BACKUP_KEYS = [
    'apiConfig',          // 全局 API（key，visionApi 识图 key 也在里面）
    'apiPresets',         // 每个预设都带 key
    'availableModels',    // 模型列表（与 API 配置配套，不带它恢复后下拉会空）
    'checkPhoneApi',      // 查岗 API
    'instantPushConfig',  // Worker 地址+token
    'pushVapid',          // VAPID 密钥对
    'studyApiConfig',     // 自习室 API
    'amsg2GlobalConfig',  // 主动消息 2.0 共享密钥/AMSG_MASTER_KEY
    'cloudBackupConfig',  // WebDAV/GitHub Releases 备份凭据
] as const;

export async function cloudSyncPush(config: CloudSyncConfig, sessionIn: CloudSyncSession, opts: PushOptions): Promise<{ rawBytes: number; gzipBytes: number }> {
    assertConfig(config);
    const session = await cloudSyncRefresh(config, sessionIn);
    if (!session) throw new CloudSyncApiError('登录已过期，请重新登录', 401);

    // 明文数据包直接 gzip 上传（RLS 行级隔离：只有本人 JWT 能读写这一行）
    opts.onProgress?.('正在 gzip 压缩…');
    const { gzipB64, gzipBytes } = await gzipBytesToB64(opts.zipBlob);
    const rawBytes = opts.zipBlob.size;
    if (gzipBytes > QUOTA_WARN_BYTES) {
        throw new Error(
            `压缩后仍有 ${(gzipBytes / 1024 / 1024).toFixed(1)}MB，接近免费套餐 500MB 上限。` +
            '建议先在「设置 → 数据管理」里清理旧媒体的聊天记录/相册再同步，或升级 Supabase 套餐。'
        );
    }

    opts.onProgress?.('正在上传到你的 Supabase…');
    const body = {
        user_id: session.userId,
        gzip_b64: gzipB64,
        raw_bytes: rawBytes,
        gzip_bytes: gzipBytes,
        snapshot_version: 2,
        device_label: opts.deviceLabel || (navigator.userAgent || '').slice(0, 60),
        pushed_at: Date.now(),
    };
    const res = await fetch(`${baseUrl(config)}/rest/v1/sully_user_data`, {
        method: 'POST',
        headers: { ...authHeaders(config, session), Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(body),
    });
    await jsonOrThrow(res, '上传失败');
    // 本机推送水位：开机自动拉新时与云端 pushed_at 对比，云端不比这个新就不动本地
    // （本机就是最后推的设备 → 拉回来只会拿到自己的数据，白白覆盖一次运行态）。
    try { localStorage.setItem('os_cloud_sync_last_push_v1', String(Date.now())); } catch { /* ignore */ }
    if (opts.secretsJson && opts.secretKey) {
        opts.onProgress?.('正在加密 API 密钥…');
        const envelope = await encryptSecrets(opts.secretKey, opts.secretsJson);
        const secRes = await fetch(`${baseUrl(config)}/rest/v1/sully_api_secrets`, {
            method: 'POST',
            headers: { ...authHeaders(config, session), Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ user_id: session.userId, envelope: JSON.stringify(envelope), pushed_at: Date.now() }),
        });
        await jsonOrThrow(secRes, 'API 密钥上传失败');
    }
    // 心跳顺带 touch（失败无所谓）
    void fetch(`${baseUrl(config)}/rest/v1/sully_heartbeat?id=eq.1`, {
        method: 'PATCH',
        headers: { ...authHeaders(config, session), Prefer: 'return=minimal' },
        body: JSON.stringify({ beat_at: Date.now() }),
    }).catch(() => {});
    return { rawBytes, gzipBytes };
}

export interface CloudSnapshotMeta {
    rawBytes: number;
    gzipBytes: number;
    deviceLabel: string;
    pushedAt: number;
}

/** 只看云端有没有备份、多新（不拉数据）——登录后换设备判断用。 */
export async function cloudSyncPeek(config: CloudSyncConfig, sessionIn: CloudSyncSession): Promise<CloudSnapshotMeta | null> {
    assertConfig(config);
    const session = await cloudSyncRefresh(config, sessionIn);
    if (!session) throw new CloudSyncApiError('登录已过期，请重新登录', 401);
    const res = await fetch(
        `${baseUrl(config)}/rest/v1/sully_user_data?select=raw_bytes,gzip_bytes,device_label,pushed_at&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`,
        { headers: authHeaders(config, session) },
    );
    const rows = await jsonOrThrow(res, '查询云端备份失败');
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return {
        rawBytes: Number(rows[0].raw_bytes) || 0,
        gzipBytes: Number(rows[0].gzip_bytes) || 0,
        deviceLabel: rows[0].device_label || '',
        pushedAt: Number(rows[0].pushed_at) || 0,
    };
}

export interface CloudPullResult {
    zipBlob: Blob;
    /** 云端有且解密成功的敏感字段明文 JSON（v2 分离格式）；null = 没有/未解密。 */
    secretsJson: string | null;
    /** 云端有加密密钥但没给密码（数据可用，API 密钥待解锁）。 */
    secretsLocked: boolean;
}

/**
 * 拉取云端备份 zip（不写入本地——写入由调用方走 importSystem 管道）。
 * v2 分离格式：明文数据包免密可拉；API 密钥等敏感字段有密码才解密返回。
 * v1 旧格式（整包加密）：必须提供 password 才能解开。
 */
export async function cloudSyncPull(config: CloudSyncConfig, sessionIn: CloudSyncSession, password: string, onProgress?: (msg: string) => void): Promise<Blob> {
    assertConfig(config);
    const session = await cloudSyncRefresh(config, sessionIn);
    if (!session) throw new CloudSyncApiError('登录已过期，请重新登录', 401);
    onProgress?.('正在下载云端备份…');
    const res = await fetch(
        `${baseUrl(config)}/rest/v1/sully_user_data?select=gzip_b64,snapshot_version,pushed_at&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`,
        { headers: authHeaders(config, session) },
    );
    const rows = await jsonOrThrow(res, '下载失败');
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.gzip_b64) {
        throw new Error('云端还没有数据。先在本机点「立刻上传」推一份。');
    }
    // 本机水位对齐到刚拉下来的这一版：不然开机自动拉新会认为「云端还比本机新」，
    // 每次启动都重复拉一遍同样的数据。
    try { localStorage.setItem('os_cloud_sync_last_push_v1', String(Number(rows[0].pushed_at) || Date.now())); } catch { /* ignore */ }
    onProgress?.('正在解压…');
    const bytes = await gunzipB64ToBytes(rows[0].gzip_b64);
    // v2 明文：字节就是 zip 本身；v1 旧整包：字节是 CipherEnvelope JSON，需密码解密
    const head = new TextDecoder().decode(bytes.subarray(0, 16));
    if (head.includes('SULLYE2E1')) {
        if (!password) throw new Error('云端是旧版整包加密备份，需要账号密码解锁后才能拉取（新上传会自动转成免密格式）');
        onProgress?.('正在解密…');
        const envelope = JSON.parse(new TextDecoder().decode(bytes)) as CipherEnvelope;
        const zipBlob = await decryptEnvelope(password, envelope);
        onProgress?.('解密完成');
        return zipBlob;
    }
    onProgress?.('下载完成');
    return new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
}

/**
 * 拉取敏感字段（API 密钥）明文 JSON。
 * 平时不用传密码：本机记住的密钥（登录时派生、extractable:false 存 IndexedDB）够用，
 * 所以每次打开页面都能自动把云端密钥解出来。换设备第一次登录时传密码派生并记住。
 * 云端没推过密钥 → null；解不开 → locked:true（数据主包不受影响，不抛错）。
 */
export async function cloudSyncPullSecrets(
    config: CloudSyncConfig,
    sessionIn: CloudSyncSession,
    password?: string,
): Promise<{ secretsJson: string | null; locked: boolean }> {
    assertConfig(config);
    const session = await cloudSyncRefresh(config, sessionIn);
    if (!session) return { secretsJson: null, locked: false };
    const key = await resolveSecretKey(session.userId, password);
    if (!key && !password) return { secretsJson: null, locked: true };
    try {
        const res = await fetch(
            `${baseUrl(config)}/rest/v1/sully_api_secrets?select=envelope&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`,
            { headers: authHeaders(config, session) },
        );
        const rows = await jsonOrThrow(res, '查询密钥失败');
        if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.envelope) return { secretsJson: null, locked: false };
        const envelope = JSON.parse(rows[0].envelope);
        return { secretsJson: await decryptSecrets(envelope, key, password), locked: false };
    } catch {
        // 密码不对/表还没建/网络问题：数据主包不受影响
        return { secretsJson: null, locked: true };
    }
}

/** 登录用户的 localStorage 设置快照（MIRRORED_KEYS 同批：API 配置等小设置）。 */
export function snapshotMirroredSettings(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of MIRRORED_KEYS) {
        try {
            const v = localStorage.getItem(key);
            if (v !== null) out[key] = v;
        } catch { /* ignore */ }
    }
    return out;
}

// ─── v2 备份包敏感字段拆分 / 合并（jszip）────────────────────────────

/**
 * 备份 zip 的敏感字段拆在哪？「设置 → 导出备份」的 v2/v3 分片格式里，非数组字段
 * 全在 metadata.json（apiConfig/apiPresets 等都在里面）。这里做的是：
 *   - 读 metadata.json，把 SECRET_BACKUP_KEYS 里的字段移进 secrets 并从原文件删除
 *   - 返回改写后的【明文数据包 zip】与【敏感字段 JSON 字符串】
 * 单文件 data.json 的 v1 老格式同理处理（整个对象就是根）。
 */
export async function splitBackupSecrets(zipBlob: Blob): Promise<{ publicZip: Blob; secretsJson: string }> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(zipBlob);
    const metaFile = zip.file('metadata.json') || zip.file('data.json');
    if (!metaFile) throw new Error('备份包里找不到 metadata.json/data.json');
    const meta = JSON.parse(await metaFile.async('string'));
    const secrets: Record<string, unknown> = {};
    for (const key of SECRET_BACKUP_KEYS) {
        if (meta[key] !== undefined) {
            secrets[key] = meta[key];
            delete meta[key];
        }
    }
    zip.file(metaFile.name, JSON.stringify(meta));
    const publicZip = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    return { publicZip, secretsJson: JSON.stringify(secrets) };
}

/** 恢复端合并：把解密出的敏感字段塞回明文数据包的 metadata，产出可直接 importSystem 的 zip。 */
export async function mergeBackupSecrets(publicZipBlob: Blob, secretsJson: string): Promise<Blob> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(publicZipBlob);
    const metaFile = zip.file('metadata.json') || zip.file('data.json');
    if (!metaFile) throw new Error('数据包里找不到 metadata.json/data.json');
    const meta = JSON.parse(await metaFile.async('string'));
    const secrets = JSON.parse(secretsJson) as Record<string, unknown>;
    for (const [k, v] of Object.entries(secrets)) meta[k] = v;
    zip.file(metaFile.name, JSON.stringify(meta));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** 从备份恢复 localStorage 设置（只回填备份里带的键；现有值由调用方决定是否覆盖）。 */
export function restoreMirroredSettings(data: Record<string, string>, overwrite: boolean): number {
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
        try {
            if (overwrite || localStorage.getItem(key) === null) {
                localStorage.setItem(key, value);
                count++;
            }
        } catch { /* ignore */ }
    }
    return count;
}
