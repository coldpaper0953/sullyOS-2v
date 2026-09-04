/**
 * autoRestore.ts
 * 「丢了才恢复」（用户 2026-09-04 拍板）：设备清后台/清缓存/换机后，下次打开
 * SullyOS 检测到本机是空机（没有任何角色和聊天记录），自动从 GitHub 最新备份
 * 恢复——行为类似聊天记录的「大重启下传备份」。
 *
 * 三道防死循环闸门（一个都不能少）：
 *  1. 恢复成功 → 写 restoredAt 标记；本机生命周期内绝不二次触发
 *     （就算恢复出来的数据又被判空机也不再来——那是数据本身为空，不是丢失）。
 *  2. 恢复失败 → 写 failedAt，进入 24h 冷却；不在每次启动时反复砸 GitHub。
 *  3. 用户主动「清除所有数据」→ 写 optOutAt，这台设备从此不再自动恢复
 *     （主动清空 ≠ 丢数据，替用户恢复回去反而是在毁他的操作）。
 *
 * 额外防线：cloudBackupConfig 没连 GitHub 时整段跳过（没东西可恢复）；
 * 检测「空机」要求 characters 和 messages 两个 store 全空，避免只清了
 * 聊天记录的设备被误判。
 *
 * 纯函数（readState/isEmptyDevice/shouldAutoRestore/cooldown）可注入 now/kv，
 * vitest 直测；副作用函数由 OSContext 在 isDataLoaded 之后调用。
 */

import type { CloudBackupConfig } from '../types';
import { isBackendBackupReady } from './backendBackupClient';

const KEY = 'sullyos_auto_restore_v1';
const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTO_RESTORE_COOLDOWN_MS = DAY_MS;

export interface AutoRestoreState {
    /** 上次成功恢复的时间戳；>0 = 本机已恢复过，不再触发 */
    restoredAt: number;
    /** 上次尝试失败的时间戳；冷却期内不再尝试 */
    failedAt: number;
    /** 用户在设置里显式关闭（或清数据）的时间戳；>0 = 永久退出自动恢复 */
    optOutAt: number;
}

export type KvLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const defaultKv = (): KvLike => {
    try { return localStorage; } catch { /* SSR/测试环境 */ }
    return {
        getItem: () => null,
        setItem: () => { /* 不可写就当没存 */ },
        removeItem: () => { /* 同上 */ },
    };
};

export function readAutoRestoreState(kv: KvLike = defaultKv()): AutoRestoreState {
    let raw: Partial<AutoRestoreState> = {};
    try {
        const s = kv.getItem(KEY);
        if (s) raw = JSON.parse(s) as Partial<AutoRestoreState>;
    } catch { /* 坏 JSON 当空处理 */ }
    return {
        restoredAt: Number(raw.restoredAt) || 0,
        failedAt: Number(raw.failedAt) || 0,
        optOutAt: Number(raw.optOutAt) || 0,
    };
}

const writeState = (s: AutoRestoreState, kv: KvLike = defaultKv()): void => {
    try { kv.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式：存不了就算了 */ }
};

/** 空机判定：角色和消息都为 0。只清聊天记录的设备（messages=0 但 characters>0）不算。 */
export const isEmptyDevice = (characterCount: number, messageCount: number): boolean =>
    characterCount === 0 && messageCount === 0;

/**
 * 要不要自动恢复（纯函数，闸门 1/2/3 + 冷却全在这）：
 *  - optOutAt > 0 → 永不
 *  - restoredAt > 0 → 已恢复过，永不（同一次数据生命周期）
 *  - failedAt 在冷却期内（默认 24h）→ 不触发
 *  - 其余情况（从未恢复过/冷却已过）→ 触发
 */
export function shouldAutoRestore(characterCount: number, messageCount: number, now: number, kv: KvLike = defaultKv()): boolean {
    if (!isEmptyDevice(characterCount, messageCount)) return false;
    const st = readAutoRestoreState(kv);
    if (st.optOutAt > 0) return false;
    if (st.restoredAt > 0) return false;
    if (st.failedAt > 0 && now - st.failedAt < AUTO_RESTORE_COOLDOWN_MS) return false;
    return true;
}

/** 恢复成功后调用（闸门 1 落地）。 */
export function markAutoRestored(now: number = Date.now(), kv: KvLike = defaultKv()): void {
    writeState({ ...readAutoRestoreState(kv), restoredAt: now, failedAt: 0 }, kv);
}

/** 恢复失败后调用（闸门 2 落地）：进冷却，不是永久放弃——下个冷却周期再试一次。 */
export function markAutoRestoreFailed(now: number = Date.now(), kv: KvLike = defaultKv()): void {
    writeState({ ...readAutoRestoreState(kv), failedAt: now }, kv);
}

/**
 * 用户显式「清除数据」/在设置里关闭时调用（闸门 3 落地）：永久退出。
 * 复位 = 重新启用自动恢复（新设备场景）。
 */
export function setAutoRestoreOptOut(optOut: boolean, now: number = Date.now(), kv: KvLike = defaultKv()): void {
    writeState({ ...readAutoRestoreState(kv), optOutAt: optOut ? now : 0 }, kv);
}

/** 自动恢复的可行性判定：github 凭据齐全或本地 backend 已配置（listBackups/download 的稳定路径）。 */
export const canAutoRestore = (config: CloudBackupConfig | undefined | null): boolean => {
    if (!config?.enabled) return false;
    if (config.provider === 'github') return !!config.githubToken && !!config.githubOwner;
    if (config.provider === 'backend') return isBackendBackupReady();
    return false;
};
