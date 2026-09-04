import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AUTO_BACKUP_DEFAULT_INTERVAL_MS,
    AUTO_BACKUP_MAX_INTERVAL_MS,
    AUTO_BACKUP_MIN_INTERVAL_MS,
    clampIntervalMs,
    computeNextDelayMs,
    isAutoBackupDue,
    readAutoBackupState,
    setAutoBackupEnabled,
    setAutoBackupInterval,
    shouldSchedulerRun,
    isAutoBackupRunning,
    startAutoBackupScheduler,
    stopAutoBackupScheduler,
    type KvLike,
} from './githubAutoBackup';

// 调度器用 document.visibilitychange；node 环境给个最小桩
beforeEach(() => {
    (globalThis as any).document = {
        visibilityState: 'visible',
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    (globalThis as any).localStorage?.clear?.();
    // vitest 按文件级作用域缓存模块 → 上个用例留下的模块级 uploadInFlight/session
    // 会泄进这个用例（调度器状态是模块单例）。vi.resetModules 后重新 import 一份干净的。
    vi.resetModules();
});

// beforeEach 的 resetModules 之后，本文件顶部的 import 绑定仍指向旧实例——
// 调度器类用例统一通过 loadFresh() 拿重置后的模块。
const loadFresh = async () => {
    const mod = await import('./githubAutoBackup');
    return mod as typeof import('./githubAutoBackup');
};

const memKv = (): { kv: KvLike; map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
        map,
        kv: {
            getItem: (k) => map.has(k) ? map.get(k)! : null,
            setItem: (k, v) => void map.set(k, String(v)),
            removeItem: (k) => void map.delete(k),
        },
    };
};

describe('clampIntervalMs', () => {
    it('非法输入回默认 4 小时', () => {
        expect(clampIntervalMs(NaN)).toBe(AUTO_BACKUP_DEFAULT_INTERVAL_MS);
        expect(clampIntervalMs(0)).toBe(AUTO_BACKUP_MIN_INTERVAL_MS);
        expect(clampIntervalMs(999 * 3600_000)).toBe(AUTO_BACKUP_MAX_INTERVAL_MS);
    });
});

describe('computeNextDelayMs（obsidian-git 补差算法）', () => {
    const HOUR = 3600_000;
    it('从未成功过 → 立刻（0）', () => {
        expect(computeNextDelayMs(4 * HOUR, 0, 123456)).toBe(0);
    });
    it('距上次备份 1h，间隔 4h → 剩 3h', () => {
        const now = 10 * HOUR;
        expect(computeNextDelayMs(4 * HOUR, now - 1 * HOUR, now)).toBe(3 * HOUR);
    });
    it('已超过间隔（睡了一夜）→ 0，只补一次不堆积', () => {
        const now = 100 * HOUR;
        expect(computeNextDelayMs(4 * HOUR, now - 30 * HOUR, now)).toBe(0);
    });
    it('isAutoBackupDue 与 delay===0 口径一致', () => {
        const now = 50 * HOUR;
        expect(isAutoBackupDue(4 * HOUR, now - 3 * HOUR, now)).toBe(false);
        expect(isAutoBackupDue(4 * HOUR, now - 4 * HOUR, now)).toBe(true);
        expect(isAutoBackupDue(4 * HOUR, 0, now)).toBe(true);
    });
});

describe('readAutoBackupState / write roundtrip', () => {
    it('坏 JSON 当空处理（关 + 默认 4h + 从未备份）', () => {
        const { kv } = memKv();
        kv.setItem('sullyos_github_auto_backup_v1', '{oops');
        const st = readAutoBackupState(kv);
        expect(st.enabled).toBe(false);
        expect(st.intervalMs).toBe(AUTO_BACKUP_DEFAULT_INTERVAL_MS);
        expect(st.lastAutoBackupAt).toBe(0);
    });
});

describe('shouldSchedulerRun', () => {
    it('只有 GitHub 已连接（enabled+token+owner）才放行', () => {
        expect(shouldSchedulerRun(undefined)).toBe(false);
        expect(shouldSchedulerRun({ enabled: true, provider: 'webdav' } as any)).toBe(false);
        expect(shouldSchedulerRun({ enabled: true, provider: 'github', githubToken: 't', githubOwner: 'o' } as any)).toBe(true);
        expect(shouldSchedulerRun({ enabled: false, provider: 'github', githubToken: 't', githubOwner: 'o' } as any)).toBe(false);
    });
});

describe('调度器单飞（fake timers）', () => {
    it('首次开 → 立刻跑一次；跑完按新锚点排下一个；期间的重叠触发被丢弃', async () => {
        vi.useFakeTimers();
        try {
            const { startAutoBackupScheduler, stopAutoBackupScheduler } = await loadFresh();
            // 调度器内部直读全局 localStorage，直接清空全局再灌开关
            const gkv = (globalThis as any).localStorage;
            gkv.setItem('sullyos_github_auto_backup_v1', JSON.stringify({ enabled: true, intervalMs: 3600_000, lastAutoBackupAt: 0 }));

            let calls = 0;
            let resolveFirst: ((v: { ok: boolean }) => void) | null = null;
            const runner = () => {
                calls++;
                // 第一次挂起，模拟正在上传
                return new Promise<{ ok: boolean }>(res => { resolveFirst = res; });
            };

            const now = vi.fn(() => 1_000_000);
            startAutoBackupScheduler(runner, now);
            await vi.advanceTimersByTimeAsync(10);
            expect(calls).toBe(1); // lastAutoBackupAt=0 → 立刻

            // 单飞：还没 resolve，重叠触发必须被丢掉
            await vi.advanceTimersByTimeAsync(3600_000);
            expect(calls).toBe(1);

            resolveFirst!({ ok: true });
            await vi.advanceTimersByTimeAsync(10);
            // 成功推进锚点后，下一个周期在 interval 之后才触发
            expect(calls).toBe(1);
            await vi.advanceTimersByTimeAsync(3600_000);
            expect(calls).toBe(2);

            stopAutoBackupScheduler();
        } finally {
            vi.useRealTimers();
        }
    });

    it('调度器中途重启（effect 重跑换 session）绝不并发第二个备份（线上双 release 教训）', async () => {
        vi.useFakeTimers();
        try {
            const { startAutoBackupScheduler, stopAutoBackupScheduler, isAutoBackupRunning } = await loadFresh();
            const gkv = (globalThis as any).localStorage;
            gkv.setItem('sullyos_github_auto_backup_v1', JSON.stringify({ enabled: true, intervalMs: 3600_000, lastAutoBackupAt: 0 }));
            let clock = 1_000_000;
            const now = vi.fn(() => clock);

            let calls = 0;
            let resolveUpload: ((v: { ok: boolean }) => void) | null = null;
            const runner = () => {
                calls++;
                return new Promise<{ ok: boolean }>(res => { resolveUpload = res; });
            };

            startAutoBackupScheduler(runner, now);
            await vi.advanceTimersByTimeAsync(10);
            expect(calls).toBe(1); // 首轮：lastAutoBackupAt=0 立刻跑
            expect(isAutoBackupRunning()).toBe(true);

            // 上传中途调度器被重启（React effect 因 cloudBackupConfig 变化重跑 stop+start）
            startAutoBackupScheduler(runner, now);
            clock += 5000;
            await vi.advanceTimersByTimeAsync(20);
            // 新 session 的 delay=0 timer 触发，但 uploadInFlight 挡住 → 只许还是 1 次
            expect(calls).toBe(1);

            resolveUpload!({ ok: true });
            await vi.advanceTimersByTimeAsync(10);
            expect(calls).toBe(1); // 成功后按新锚点排下一个，不在眼前
            expect(isAutoBackupRunning()).toBe(false);

            clock += 3600_000;
            await vi.advanceTimersByTimeAsync(3600_000);
            expect(calls).toBe(2); // 一个周期后正常第二轮
            stopAutoBackupScheduler();
        } finally {
            vi.useRealTimers();
        }
    });

    it('失败不推进锚点，也不许 back-to-back：从现在起等一个完整 interval 再试', async () => {
        vi.useFakeTimers();
        try {
            const { startAutoBackupScheduler, stopAutoBackupScheduler } = await loadFresh();
            const gkv = (globalThis as any).localStorage;
            const t0 = 5_000_000;
            gkv.setItem('sullyos_github_auto_backup_v1', JSON.stringify({ enabled: true, intervalMs: 3600_000, lastAutoBackupAt: t0 }));
            const now = vi.fn(() => t0 + 3600_000); // 一到点就到点

            let calls = 0;
            const runner = async () => { calls++; return { ok: false, error: '网络炸了' }; };
            startAutoBackupScheduler(runner, now);
            await vi.advanceTimersByTimeAsync(10);
            expect(calls).toBe(1);
            // 失败后锚点不动（delay 会算 0），调度器必须改排一个完整 interval，
            // 否则就是「失败→立刻重试→再失败」的死循环连砸 GitHub
            await vi.advanceTimersByTimeAsync(10);
            expect(calls).toBe(1); // 10ms 内绝不重试
            await vi.advanceTimersByTimeAsync(3600_000);
            expect(calls).toBe(2); // 一个 interval 后再试一次
            stopAutoBackupScheduler();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('setAutoBackupEnabled / setAutoBackupInterval', () => {
    it('改间隔立即 clamp 并落库', async () => {
        const { setAutoBackupInterval, setAutoBackupEnabled, stopAutoBackupScheduler } = await loadFresh();
        const gkv = (globalThis as any).localStorage;
        const next = setAutoBackupInterval(1000, async () => ({ ok: true }), () => 1); // 1 秒会被 clamp 到 10 分钟下限
        expect(next.intervalMs).toBe(AUTO_BACKUP_MIN_INTERVAL_MS);
        expect(gkv.getItem('sullyos_github_auto_backup_v1')).toContain(String(AUTO_BACKUP_MIN_INTERVAL_MS));
        stopAutoBackupScheduler();

        const off = setAutoBackupEnabled(false, async () => ({ ok: true }), () => 1);
        expect(off.enabled).toBe(false);
        stopAutoBackupScheduler();
    });
});
