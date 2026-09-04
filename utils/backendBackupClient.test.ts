import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * backendBackupClient 单测 —— mock fetch + 种 localStorage 的 sullyos_backend_chat_v1。
 * 后端行为（zip→文件树→git commit）在 backend/tests/backup.test.ts 已用真 git 全链路验证，
 * 这里只测客户端契约：URL 拼接、Bearer 头、{data,error} 解包、错误文案聚合。
 */

const CONFIG_KEY = 'sullyos_backend_chat_v1';

const seedBackendConfig = (baseUrl: string, token: string) => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ enabled: true, serverContextEnabled: false, baseUrl, token }));
};

type FetchMock = ReturnType<typeof vi.fn>;

const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response);

const blobResponse = () =>
    ({ ok: true, status: 200, blob: async () => new Blob(['zip-bytes'], { type: 'application/zip' }) } as unknown as Response);

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('isBackendBackupReady', () => {
    it('地址+令牌齐全才算就绪；缺令牌不算', async () => {
        const { isBackendBackupReady } = await import('./backendBackupClient');
        expect(isBackendBackupReady()).toBe(false); // 什么都没配
        seedBackendConfig('http://127.0.0.1:43210', 'dev-token');
        expect(isBackendBackupReady()).toBe(true);
        // 空 baseUrl 会被 loadBackendChatConfig 回填成默认地址（127.0.0.1:43210）——
        // 有令牌就算就绪，这是既定归一化行为
        seedBackendConfig('   ', 'dev-token');
        expect(isBackendBackupReady()).toBe(true);
        // 令牌空 → 永远不算就绪（fetch 会 401，不能让调度器空转）
        seedBackendConfig('http://127.0.0.1:43210', '');
        expect(isBackendBackupReady()).toBe(false);
    });
});

describe('testConnection', () => {
    it('GET /v1/backup/status 带 Bearer；仓库有提交 → 成功文案带文件数', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        const fetchMock: FetchMock = vi.fn(async () => jsonResponse(200, {
            data: { exists: true, latestCommit: 'abcd1234', fileCount: 42, commitTime: null, sizeBytes: 1 },
        }));
        vi.stubGlobal('fetch', fetchMock);
        const { testConnection } = await import('./backendBackupClient');
        const result = await testConnection({} as any);
        expect(result.ok).toBe(true);
        expect(result.message).toContain('42');
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:43210/v1/backup/status',
            expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer tok' }) }),
        );
    });

    it('空仓库 → 提示还是空的；HTTP 401 → 失败文案带服务端 message', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        const { testConnection } = await import('./backendBackupClient');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { exists: false, latestCommit: null, fileCount: 0 } })));
        expect((await testConnection({} as any)).message).toContain('空的');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized', message: 'token 不对' })));
        const failed = await testConnection({} as any);
        expect(failed.ok).toBe(false);
        expect(failed.message).toContain('token 不对');
    });

    it('未配置令牌 → 直接失败，不发请求', async () => {
        const { testConnection } = await import('./backendBackupClient');
        const fetchMock: FetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const result = await testConnection({} as any);
        expect(result.ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('uploadBackup', () => {
    it('POST /v1/backup/upload 带 zip content-type；成功返回 commit 前 8 位', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        const fetchMock: FetchMock = vi.fn(async () => jsonResponse(200, {
            data: { committed: true, commit: '0123456789abcdef', fileCount: 7 },
        }));
        vi.stubGlobal('fetch', fetchMock);
        const { uploadBackup } = await import('./backendBackupClient');
        const blob = new Blob(['zip'], { type: 'application/zip' });
        const result = await uploadBackup({} as any, blob, 'backup.zip');
        expect(result.ok).toBe(true);
        expect(result.message).toContain('01234567');
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:43210/v1/backup/upload');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/zip');
    });

    it('committed:false → 文案是「内容无变化」', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
            data: { committed: false, commit: null, fileCount: 7 },
        })));
        const { uploadBackup } = await import('./backendBackupClient');
        const result = await uploadBackup({} as any, new Blob(['zip']), 'b.zip');
        expect(result.ok).toBe(true);
        expect(result.message).toContain('无变化');
    });

    it('拒收（backup_rejected）→ details 聚合进中文文案', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, {
            error: 'backup_rejected',
            message: '备份包含疑似密钥字段',
            details: ['stores/characters.json#apiKey', 'metadata.json#token'],
        })));
        const { uploadBackup } = await import('./backendBackupClient');
        const result = await uploadBackup({} as any, new Blob(['zip']), 'b.zip');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('stores/characters.json#apiKey');
        expect(result.message).toContain('metadata.json#token');
    });
});

describe('listBackups / downloadBackup / deleteBackup / cleanupOldBackups', () => {
    it('history 映射 CloudBackupFile[]', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            // history 请求必须带 Bearer
            expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer tok');
            return jsonResponse(200, { data: [{ name: 'backup 2026-09-04 (abcd1234)', href: 'abcd1234…', lastModified: '2026-09-04T01:02:03Z', status: 'ready', size: 1024 }] });
        }));
        const { listBackups } = await import('./backendBackupClient');
        const files = await listBackups({} as any);
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('backup 2026-09-04 (abcd1234).zip'); // 自动恢复的 zip 分流靠后缀
        expect(files[0].status).toBe('ready');
    });

    it('download 返回 blob；HTTP 失败/网络炸 → null', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        const { downloadBackup } = await import('./backendBackupClient');
        vi.stubGlobal('fetch', vi.fn(async () => blobResponse()));
        const blob = await downloadBackup({} as any, {} as any);
        expect(blob).toBeInstanceOf(Blob);
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'empty_repo' })));
        expect(await downloadBackup({} as any, {} as any)).toBeNull();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        expect(await downloadBackup({} as any, {} as any)).toBeNull();
    });

    it('delete/cleanup 是 no-op：git 历史保留，永不删提交', async () => {
        const fetchMock: FetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { deleteBackup, cleanupOldBackups } = await import('./backendBackupClient');
        expect(await deleteBackup({} as any, {} as any)).toBe(true);
        expect(await cleanupOldBackups({} as any, 1)).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('fetchBackupStatus（新提交检查）', () => {
    it('成功返回 status；任何失败 → null（不弹错）', async () => {
        seedBackendConfig('http://127.0.0.1:43210', 'tok');
        const { fetchBackupStatus } = await import('./backendBackupClient');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
            data: { exists: true, latestCommit: 'ff00', commitTime: '2026-09-04T00:00:00Z', fileCount: 9, sizeBytes: 2 },
        })));
        const st = await fetchBackupStatus();
        expect(st?.latestCommit).toBe('ff00');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('backend down'); }));
        expect(await fetchBackupStatus()).toBeNull();
    });
});
