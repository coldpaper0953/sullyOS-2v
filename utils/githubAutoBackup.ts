/**
 * githubAutoBackup.ts
 * GitHub Releases 自动备份的调度层 + 纯逻辑（仿 obsidian-git automaticsManager 的骨架）。
 *
 * 用户需求（2026-09-04 拍板）：「每间隔 4 小时就备份一次，密钥保留在表单，不进备份包」。
 * 自动备份只走 text_only + stripSecrets——仓库/附件是外部托管，绝不能落明文密钥；
 * 密钥的跨设备流转由逐键加密同步层（sully_settings 表）负责，两边职责分开。
 *
 * 设计要点（对着 obsidian-git 学的，Vinzent03/obsidian-git 的 automaticsManager.ts）：
 *  - 补差算法：nextDelay = max(0, interval − (now − lastBackupAt))。设备睡眠/标签页
 *    被节流错过的周期只补一次，绝不堆积成「一醒来连发 N 个备份」。
 *  - setTimeout 链而非 setInterval：单飞队列（running 标志）挡重入；成功才推进
 *    lastBackupAt 锚点（失败不推进，下个周期按原锚点补），时间戳只在成功时写。
 *  - 回到前台重算：visibilitychange 变 visible 时清旧 timer、按差值重排（后台 timer
 *    被浏览器大幅节流，回前台补跑一次即可）。
 *  - 改开关/改间隔 = 停旧 timer 重排（对应 obsidian-git 的 reload timers）。
 *
 * 纯函数（computeNextDelayMs / clampIntervalMs / readAutoBackupState 等）全部接受
 * 可注入的 now / storage，vitest 直测，不碰真实定时器。
 */

import type { CloudBackupConfig } from '../types';

const KEY = 'sullyos_github_auto_backup_v1';
const HOUR_MS = 60 * 60 * 1000;

/** setTimeout 的合法上限（2^31−1 ms ≈ 24.8 天），超过会立刻触发。 */
export const MAX_TIMEOUT_MS = 2147483647;

export const AUTO_BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;      // 最短 10 分钟（验收时临时调短也够用）
export const AUTO_BACKUP_DEFAULT_INTERVAL_MS = 4 * HOUR_MS;     // 用户拍板的默认值
export const AUTO_BACKUP_MAX_INTERVAL_MS = 24 * HOUR_MS;

export const AUTO_BACKUP_INTERVAL_CHOICES_MS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 1 * HOUR_MS, label: '1 小时' },
    { value: 2 * HOUR_MS, label: '2 小时' },
    { value: AUTO_BACKUP_DEFAULT_INTERVAL_MS, label: '4 小时' },
    { value: 12 * HOUR_MS, label: '12 小时' },
    { value: AUTO_BACKUP_MAX_INTERVAL_MS, label: '24 小时' },
];

export interface AutoBackupState {
    /** 自动备份总开关；关闭 = 停止调度，不动已上传的备份 */
    enabled: boolean;
    /** 调度间隔（ms），clampIntervalMs 保证在合法区间 */
    intervalMs: number;
    /** 上一次「自动」备份成功的时间戳（ms）；0 = 自动备份从未成功过。
     *  注意与 cloudBackupConfig.lastBackupTime（手动+自动共用）区分：调度锚点用这个，
     *  这样手动备份不会把自动的锚点往前推、导致自动备份被无限顺延。 */
    lastAutoBackupAt: number;
}

export const clampIntervalMs = (n: number): number => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return AUTO_BACKUP_DEFAULT_INTERVAL_MS;
    return Math.min(AUTO_BACKUP_MAX_INTERVAL_MS, Math.max(AUTO_BACKUP_MIN_INTERVAL_MS, v));
};

// ---- 可注入的 localStorage（vitest 传内存 Map 实现，浏览器传真 localStorage）----
export type KvLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const defaultKv = (): KvLike => {
    try { return localStorage; } catch { /* SSR/测试环境 */ }
    return {
        getItem: () => null,
        setItem: () => { /* 不可写就当没存 */ },
        removeItem: () => { /* 同上 */ },
    };
};

export function readAutoBackupState(kv: KvLike = defaultKv()): AutoBackupState {
    let raw: Partial<AutoBackupState> = {};
    try {
        const s = kv.getItem(KEY);
        if (s) raw = JSON.parse(s) as Partial<AutoBackupState>;
    } catch { /* 坏 JSON 当空处理 */ }
    return {
        enabled: raw.enabled === true,
        intervalMs: clampIntervalMs(raw.intervalMs ?? AUTO_BACKUP_DEFAULT_INTERVAL_MS),
        lastAutoBackupAt: Number(raw.lastAutoBackupAt) || 0,
    };
}

export function writeAutoBackupState(next: AutoBackupState, kv: KvLike = defaultKv()): AutoBackupState {
    try { kv.setItem(KEY, JSON.stringify(next)); } catch { /* 隐私模式：存不了就算了 */ }
    return next;
}

/**
 * 补差算法（obsidian-git 的 diff catch-up）：
 *   距上次成功备份已过 interval → 0（立刻补一次，且只补一次）；
 *   未到点 → 剩余时间；
 *   从未成功过（lastBackupAt=0）→ 立刻（首开开关的人马上得到第一个备份）。
 */
export function computeNextDelayMs(intervalMs: number, lastBackupAt: number, now: number): number {
    if (lastBackupAt <= 0) return 0;
    return Math.max(0, intervalMs - (now - lastBackupAt));
}

/** 备份是否已经到点（调度与「前台重算」共用同一个判定，避免两边口径不一）。 */
export function isAutoBackupDue(intervalMs: number, lastBackupAt: number, now: number): boolean {
    return computeNextDelayMs(intervalMs, lastBackupAt, now) === 0;
}

// ==== 调度器（浏览器侧；纯逻辑在上面，这里只做定时器和单飞）====

/** 单一职责注入：由 OSContext 提供真正干活的上传函数（exportSystem('text_only',{stripSecrets}) → uploadBackup → cleanup）。
 *  返回 ok/failure；调度器只认结果，不关心网络细节。 */
export type AutoBackupRunner = () => Promise<{ ok: boolean; error?: string }>;

interface SchedulerSession {
    timerId: ReturnType<typeof setTimeout> | null;
    running: boolean;
    visibilityHandler: (() => void) | null;
}

/** 模块级唯一会话（obsidian-git 同款单飞：同一时刻最多一个调度循环）。 */
let session: SchedulerSession | null = null;

/**
 * 进程级单飞：正在上传时就算调度器被重启（React effect 重跑 → stop/start 换 session），
 * 也绝不放行第二个备份。obsidian-git 的 promiseQueue 是模块级单例，同样跨重启存活；
 * SullyOS 的调度器会因 cloudBackupConfig 变化而重建，必须把「在跑」这个事实放到 session
 * 外面，否则重启后的新 session running=false，正在上传的那轮会被并发复制一份
 * （线上实测教训：同一次刷新产生两个相隔 10 秒的备份 release）。
 */
let uploadInFlight: Promise<{ ok: boolean; error?: string }> | null = null;

const clearTimer = (): void => {
    if (session && session.timerId !== null && session.timerId !== undefined) {
        clearTimeout(session.timerId);
    }
    if (session) session.timerId = null;
};

/** 跑一次备份。进程级单飞：还在上传就直接返回、**不回调 onDone**——在跑的那一轮
 *  跑完会自己按「此刻」的 session 重排 timer（可能已被 stop/start 换过），这里若再
 *  按成功分支重排，会用还没推进的旧锚点算出 delay=0，形成 setTimeout(0) 热循环。 */
const runOnce = async (runner: AutoBackupRunner, now: () => number, onDone?: (ok: boolean) => void): Promise<void> => {
    if (uploadInFlight) return;
    if (!session) {
        onDone?.(false);
        return;
    }
    session.running = true;
    uploadInFlight = (async () => {
        try {
            return await runner();
        } catch (e: any) {
            return { ok: false, error: e?.message || String(e) };
        } finally {
            uploadInFlight = null;
            if (session) session.running = false;
        }
    })();
    const result = await uploadInFlight;
    if (result.ok) {
        // 时间戳只在成功时写（obsidian-git 铁律）；失败不推进锚点
        const st = readAutoBackupState();
        writeAutoBackupState({ ...st, lastAutoBackupAt: now() });
    }
    onDone?.(result.ok);
};

/** 备份结束后的重排：
 *  - 成功 → 按新锚点算剩余时间，正常排下一个周期；
 *  - 失败 → 锚点不动（delay 会算出 0），若照排会变成「失败→立刻重试→再失败」的
 *    死循环连砸 GitHub。所以失败后从现在起等一个完整 interval 再试一次
 *    （obsidian-git：失败也照样按 interval 排，绝不 back-to-back）。 */
const handleDoneAndReschedule = (ok: boolean, runner: AutoBackupRunner, now: () => number): void => {
    if (!session) return; // 期间调度器被拆掉（关开关/断连）：不重排，跑完的那轮自然收尾
    if (ok) {
        scheduleNext(runner, now);
        return;
    }
    const st = readAutoBackupState();
    session.timerId = setTimeout(() => scheduleNext(runner, now), Math.min(st.intervalMs, MAX_TIMEOUT_MS));
};

/** 排下一个 timer。到点跑一次，跑完再排下一个（setTimeout 链，非 setInterval）。 */
const scheduleNext = (runner: AutoBackupRunner, now: () => number): void => {
    if (!session) return;
    const st = readAutoBackupState();
    const delay = computeNextDelayMs(st.intervalMs, st.lastAutoBackupAt, now());
    const safeDelay = Math.min(delay, MAX_TIMEOUT_MS); // interval 本身 < 24h，这里只是双保险
    session.timerId = setTimeout(() => {
        void runOnce(runner, now, ok => handleDoneAndReschedule(ok, runner, now));
    }, safeDelay);
};

/**
 * 启动/重启自动备份调度。幂等：重复调用先拆旧会话再建新的（改间隔、手动重连都走它）。
 * 前置条件（cloudBackupConfig.enabled && provider==='github'）由调用方判断；
 * 状态里 enabled=false 时不建 timer，只挂前台监听（用户把开关打开的瞬间由
 * setAutoBackupEnabled 重启调度）。
 */
export function startAutoBackupScheduler(runner: AutoBackupRunner, now: () => number = Date.now): void {
    stopAutoBackupScheduler();
    session = { timerId: null, running: false, visibilityHandler: null };

    const st = readAutoBackupState();
    if (st.enabled) {
        scheduleNext(runner, now);
        // 回到前台：后台 timer 被浏览器节流（Chrome 后台标签 1 次/分钟甚至冻结），
        // 变 visible 时按差值算法重排——已到点则立刻补跑，没到点则对齐剩余时间
        const handler = () => {
            if (document.visibilityState !== 'visible') return;
            const cur = readAutoBackupState();
            if (!cur.enabled) return;
            clearTimer();
            if (isAutoBackupDue(cur.intervalMs, cur.lastAutoBackupAt, now())) {
                void runOnce(runner, now, ok => handleDoneAndReschedule(ok, runner, now));
            } else {
                scheduleNext(runner, now);
            }
        };
        document.addEventListener('visibilitychange', handler);
        session.visibilityHandler = handler;
    }
}

/** 完全停止（关开关、断开 GitHub 连接、组件卸载时）。 */
export function stopAutoBackupScheduler(): void {
    if (!session) return;
    clearTimer();
    if (session.visibilityHandler) {
        document.removeEventListener('visibilitychange', session.visibilityHandler);
    }
    session = null;
}

/** 当前是否有个备份正在上传（避免设置页在跑的过程中让用户重复点「立即备份」）。
 *  看进程级 uploadInFlight 而不是 session——上传跨调度器重启存活。 */
export const isAutoBackupRunning = (): boolean => uploadInFlight !== null;

// ---- 用户操作（设置页调用）----

export function setAutoBackupEnabled(enabled: boolean, runner: AutoBackupRunner, now: () => number = Date.now): AutoBackupState {
    const next = { ...readAutoBackupState(), enabled };
    writeAutoBackupState(next);
    // 开 = 重启调度（首次开且从未成功过 → computeNextDelayMs 返回 0，马上出第一个备份）
    startAutoBackupScheduler(runner, now);
    return next;
}

export function setAutoBackupInterval(intervalMs: number, runner: AutoBackupRunner, now: () => number = Date.now): AutoBackupState {
    const next = { ...readAutoBackupState(), intervalMs: clampIntervalMs(intervalMs) };
    writeAutoBackupState(next);
    // 改间隔立即重排（obsidian-git：interval 变了要 reload timers）
    if (next.enabled) startAutoBackupScheduler(runner, now);
    return next;
}

/** 自动备份调度是否该启动的统一判定（OSContext 启动 + cloudBackupConfig 变化时调用）。 */
export const shouldSchedulerRun = (config: CloudBackupConfig | undefined | null): boolean =>
    !!config?.enabled && config.provider === 'github' && !!config.githubToken && !!config.githubOwner;
