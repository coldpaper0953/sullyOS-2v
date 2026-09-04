import { describe, expect, it } from 'vitest';
import { deepStripSecrets } from './backupSystem';

describe('deepStripSecrets（GitHub 自动备份的密钥剥离）', () => {
    it('剥 apiKey/token/secret/password/privateKey/sharedKey/authorization 字段，保留结构', () => {
        const input = {
            apiConfig: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-value', model: 'gpt-x' },
            pushVapid: { vapidPublicKey: 'pub-keep', vapidPrivateKey: 'priv-stripped' },
            luckinLocal: { token: 'lk-token', enabled: 'true' },
        };
        const out = deepStripSecrets(input) as typeof input;
        expect(out.apiConfig.baseUrl).toBe('https://api.example.com/v1');
        expect(out.apiConfig.model).toBe('gpt-x');
        expect(out.apiConfig.apiKey).toBe('');
        expect(out.pushVapid.vapidPublicKey).toBe('pub-keep');
        expect(out.pushVapid.vapidPrivateKey).toBe('');
        expect(out.luckinLocal.token).toBe('');
        expect(out.luckinLocal.enabled).toBe('true');
    });

    it('数组与深层嵌套都剥', () => {
        const input = {
            characters: [
                { id: 'c1', name: '小眠', emotionConfig: { api: { baseUrl: 'https://x', apiKey: 'sk-1', model: 'm' } } },
                { id: 'c2', name: '阿澈', emotionConfig: { api: { baseUrl: 'https://y', apiKey: 'sk-2' } } },
            ],
        };
        const out = deepStripSecrets(input) as typeof input;
        expect(out.characters[0].emotionConfig.api.apiKey).toBe('');
        expect(out.characters[0].emotionConfig.api.model).toBe('m');
        expect(out.characters[1].emotionConfig.api.apiKey).toBe('');
        expect(out.characters[1].name).toBe('阿澈');
    });

    it('裸 key 字段不剥（vrPresets 的 key 是风格 ID，不是凭据）', () => {
        const input = { vrPresets: [{ key: 'gentle-style', name: '温柔', prompt: '...' }] };
        const out = deepStripSecrets(input) as typeof input;
        expect(out.vrPresets[0].key).toBe('gentle-style');
    });

    it('大小写与命名变体都覆盖（apiKey / api_key / APIKEY / bearerToken / authHeader）', () => {
        const input = {
            apiKey: 'a', api_key: 'b', APIKEY: 'c', bearerToken: 'd',
            authHeader: 'e', sharedSecret: 'f', masterPassword: 'g',
        };
        const out = deepStripSecrets(input) as Record<string, string>;
        expect(out.apiKey).toBe('');
        expect(out.api_key).toBe('');
        expect(out.APIKEY).toBe('');
        expect(out.bearerToken).toBe('');
        expect(out.authHeader).toBe('');
        expect(out.sharedSecret).toBe('');
        expect(out.masterPassword).toBe('');
    });

    it('非字符串字段原样通过（数字/布尔/null）', () => {
        const input = { count: 3, enabled: true, nothing: null, tokens: [1, 2] };
        const out = deepStripSecrets(input) as typeof input;
        expect(out.count).toBe(3);
        expect(out.enabled).toBe(true);
        expect(out.nothing).toBeNull();
        expect(out.tokens).toEqual([1, 2]);
    });
});
