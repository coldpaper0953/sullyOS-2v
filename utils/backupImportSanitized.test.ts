import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 回归锁：导入**脱敏**备份（GitHub 自动备份导出的包，apiKey 全空）不能抹掉本机
// 已填好的真实凭据。2026-09-04 线上「清空设备→自动恢复」实测抓到：恢复完成后
// os_api_config.apiKey 与所有预设 key 全变空串，用户得重新手填所有密钥。
//
// 导入端的合并语义（backupSystem.ts importSystemImpl 的 settings 段）：
//  - apiConfig：备份带非空 key 才覆盖；空 key 时干脆不传 apiKey 键（updateApiConfig
//    是 {...本机, ...updates} 的 merge 语义，传 undefined 也会覆盖）
//  - apiPresets：savePresets 整组替换 → 同 id 的预设从本机回填非空 key
//  - realtimeConfig：*ApiKey 空串时保留本机值，其余字段照常恢复

const SOURCE = readFileSync(
    fileURLToPath(new URL('./backupSystem.ts', import.meta.url)),
    'utf8',
);

describe('导入脱敏备份不抹本机凭据', () => {
    it('apiConfig：空 key 时剔除 apiKey 键再 merge（不传 undefined）', () => {
        // 剔除键的解构写法必须在；旧的无条件覆盖写法必须消失
        expect(SOURCE).toContain('const { apiKey: incomingKey, ...restConfig } = data.apiConfig;');
        expect(SOURCE).not.toContain('if (data.apiConfig) deps.updateApiConfig(data.apiConfig);');
    });

    it('apiPresets：同 id 从本机回填非空 key 后再整组替换', () => {
        expect(SOURCE).toContain('localKeyById.get(p?.id)');
        expect(SOURCE).not.toContain('if (data.apiPresets) deps.savePresets(data.apiPresets);');
    });

    it('realtimeConfig：*ApiKey 空串保留本机值', () => {
        expect(SOURCE).toContain("if (!/api[-_]?key|token|secret|authorization|auth[-_]?header/i.test(k)) continue;");
    });
});
