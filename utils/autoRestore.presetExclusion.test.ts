import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 回归锁：自动恢复的空机判定必须剔除内置 Sully 预设角色。
// 2026-09-04 线上实测：数据初始化在 isDataLoaded 之前就把 preset-sully-v2 播种进
// 空库，导致 characters 计数恒 ≥1、「空机」永远不成立、自动恢复永远不触发
// （清空设备后轮询 70 秒 restoredAt 始终为 0）。修复 = 计数时跳过内置预设 id。

const OS_CONTEXT = readFileSync(
    fileURLToPath(new URL('../context/OSContext.tsx', import.meta.url)),
    'utf8',
);

describe('自动恢复空机判定剔除内置预设', () => {
    it('恢复效应里 characters 计数跳过 preset-sully-v2', () => {
        // OSContext 恢复效应的计数逻辑：非内置预设才计入 userCharacterCount
        expect(OS_CONTEXT).toContain(
            "if (item?.id !== sullyV2.id) userCharacterCount++",
        );
    });

    it('不再把 characters 全量计数当成空机依据（旧写法必须消失）', () => {
        expect(OS_CONTEXT).not.toContain(
            "await DB.streamRawStoreData('characters', () => { characterCount++; });",
        );
    });
});
