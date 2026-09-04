import { beforeEach, describe, expect, it } from 'vitest';
import {
    AUTO_RESTORE_COOLDOWN_MS,
    canAutoRestore,
    isEmptyDevice,
    markAutoRestoreFailed,
    markAutoRestored,
    readAutoRestoreState,
    setAutoRestoreOptOut,
    shouldAutoRestore,
    type KvLike,
} from './autoRestore';

const memKv = (): KvLike => {
    const map = new Map<string, string>();
    return {
        getItem: (k) => map.has(k) ? map.get(k)! : null,
        setItem: (k, v) => void map.set(k, String(v)),
        removeItem: (k) => void map.delete(k),
    };
};

beforeEach(() => {
    (globalThis as any).localStorage?.clear?.();
});

describe('isEmptyDevice', () => {
    it('角色和消息都为 0 才算空机', () => {
        expect(isEmptyDevice(0, 0)).toBe(true);
        expect(isEmptyDevice(3, 0)).toBe(false); // 只清了聊天记录的设备
        expect(isEmptyDevice(0, 7)).toBe(false); // 聊天在但角色没了（异常态，不自动恢复）
    });
});

describe('shouldAutoRestore 三道闸门', () => {
    it('默认状态 + 空机 → 触发', () => {
        expect(shouldAutoRestore(0, 0, 1000, memKv())).toBe(true);
    });

    it('非空机 → 永不触发', () => {
        expect(shouldAutoRestore(2, 5, 1000, memKv())).toBe(false);
    });

    it('闸门1：成功恢复过 → 不再触发', () => {
        const kv = memKv();
        markAutoRestored(2000, kv);
        expect(shouldAutoRestore(0, 0, 99999, kv)).toBe(false);
    });

    it('闸门2：失败进 24h 冷却；冷却过后可再试', () => {
        const kv = memKv();
        const failedAt = 10_000;
        markAutoRestoreFailed(failedAt, kv);
        expect(shouldAutoRestore(0, 0, failedAt + AUTO_RESTORE_COOLDOWN_MS - 1, kv)).toBe(false);
        expect(shouldAutoRestore(0, 0, failedAt + AUTO_RESTORE_COOLDOWN_MS + 1, kv)).toBe(true);
    });

    it('闸门3：用户主动清数据（optOut）→ 永久退出；复位后重新启用', () => {
        const kv = memKv();
        setAutoRestoreOptOut(true, 3000, kv);
        expect(shouldAutoRestore(0, 0, 9999999, kv)).toBe(false);
        setAutoRestoreOptOut(false, 4000, kv);
        expect(shouldAutoRestore(0, 0, 5000, kv)).toBe(true);
    });

    it('闸门优先级：optOut 压过一切（即使从未失败）', () => {
        const kv = memKv();
        setAutoRestoreOptOut(true, 1, kv);
        markAutoRestoreFailed(2, kv); // 坏 JSON 之类导致的乱序状态
        expect(readAutoRestoreState(kv).optOutAt).toBe(1);
        expect(shouldAutoRestore(0, 0, 100, kv)).toBe(false);
    });

    it('恢复成功清掉失败时间戳（下次冷却从零开始）', () => {
        const kv = memKv();
        markAutoRestoreFailed(1000, kv);
        markAutoRestored(2000, kv);
        const st = readAutoRestoreState(kv);
        expect(st.restoredAt).toBe(2000);
        expect(st.failedAt).toBe(0);
    });
});

describe('canAutoRestore', () => {
    it('只认 GitHub 且凭据齐全', () => {
        expect(canAutoRestore(undefined)).toBe(false);
        expect(canAutoRestore({ enabled: true, provider: 'webdav' } as any)).toBe(false);
        expect(canAutoRestore({ enabled: true, provider: 'github', githubToken: 't', githubOwner: 'o' } as any)).toBe(true);
        expect(canAutoRestore({ enabled: true, provider: 'github', githubToken: 't' } as any)).toBe(false);
    });
});
