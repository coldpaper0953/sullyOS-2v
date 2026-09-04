import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudBackupConfig } from '../types';

const baseConfig = (over: Partial<CloudBackupConfig> = {}): CloudBackupConfig => ({
    enabled: true,
    webdavUrl: '',
    username: '',
    password: '',
    remotePath: '/SullyBackup/',
    ...over,
});

const githubMocks = {
    listBackups: vi.fn(),
    deleteBackup: vi.fn(),
};
const webdavMocks = {
    listBackups: vi.fn(),
    deleteBackup: vi.fn(),
};
const backendMocks = {
    isBackendBackupReady: vi.fn(),
    purgeAllBackups: vi.fn(),
};
const cloudSyncMocks = {
    loadCloudSyncConfig: vi.fn(),
    loadCloudSyncSession: vi.fn(),
};

vi.mock('../utils/githubClient', () => githubMocks);
vi.mock('../utils/webdavClient', () => webdavMocks);
vi.mock('../utils/backendBackupClient', () => backendMocks);
vi.mock('../utils/cloudSync', () => cloudSyncMocks);

const { purgeCloudBackups } = await import('../utils/purgeCloudBackups');

describe('purgeCloudBackups（格式化 · 连云端备份一起清）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // 默认：云同步没配置 → 跳过，测试只盯 provider 分支
        cloudSyncMocks.loadCloudSyncConfig.mockReturnValue({ supabaseUrl: '', supabaseAnonKey: '', autoSync: false });
        cloudSyncMocks.loadCloudSyncSession.mockReturnValue(null);
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('backend 通道：调 purgeAllBackups', async () => {
        backendMocks.isBackendBackupReady.mockReturnValue(true);
        backendMocks.purgeAllBackups.mockResolvedValue({ ok: true, message: '本地后端备份仓库已清空（1.2 MB，git 历史一并删除）' });

        const report = await purgeCloudBackups(baseConfig({ provider: 'backend' }));

        expect(backendMocks.purgeAllBackups).toHaveBeenCalledTimes(1);
        expect(report.allOk).toBe(true);
        expect(report.steps[0].label).toBe('本地后端备份');
    });

    it('backend 通道未配置 → 跳过而不是失败', async () => {
        backendMocks.isBackendBackupReady.mockReturnValue(false);

        const report = await purgeCloudBackups(baseConfig({ provider: 'backend' }));

        expect(backendMocks.purgeAllBackups).not.toHaveBeenCalled();
        expect(report.allOk).toBe(true);
        expect(report.steps[0].message).toContain('跳过');
    });

    it('github 通道：连中断分片一起删（不像 cleanupOldBackups 跳过 incomplete）', async () => {
        githubMocks.listBackups.mockResolvedValue([
            { name: 'a.zip', size: 1, lastModified: '', href: '1:a', status: 'ready' },
            { name: 'b.zip', size: 1, lastModified: '', href: '2:b', status: 'incomplete' },
        ]);
        githubMocks.deleteBackup.mockResolvedValue(true);

        const report = await purgeCloudBackups(baseConfig({ provider: 'github', githubToken: 't', githubOwner: 'o' }));

        expect(githubMocks.deleteBackup).toHaveBeenCalledTimes(2);
        expect(report.allOk).toBe(true);
        expect(report.steps[0].message).toContain('2');
    });

    it('github 有删不掉的 → 报失败并提示手动删', async () => {
        githubMocks.listBackups.mockResolvedValue([
            { name: 'a.zip', size: 1, lastModified: '', href: '1:a', status: 'ready' },
            { name: 'b.zip', size: 1, lastModified: '', href: '2:b', status: 'ready' },
        ]);
        githubMocks.deleteBackup.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        const report = await purgeCloudBackups(baseConfig({ provider: 'github', githubToken: 't', githubOwner: 'o' }));

        expect(report.allOk).toBe(false);
        expect(report.steps[0].message).toContain('手动删');
    });

    it('github 未配置 token → 跳过', async () => {
        const report = await purgeCloudBackups(baseConfig({ provider: 'github' }));
        expect(githubMocks.listBackups).not.toHaveBeenCalled();
        expect(report.allOk).toBe(true);
    });

    it('webdav 通道：逐个删备份文件', async () => {
        webdavMocks.listBackups.mockResolvedValue([
            { name: 'a.zip', size: 1, lastModified: '', href: '/a.zip' },
        ]);
        webdavMocks.deleteBackup.mockResolvedValue(true);

        const report = await purgeCloudBackups(baseConfig({ provider: 'webdav', webdavUrl: 'https://dav/', username: 'u' }));

        expect(webdavMocks.deleteBackup).toHaveBeenCalledTimes(1);
        expect(report.allOk).toBe(true);
    });

    it('provider 抛错 → 记为失败但不炸整个流程（本机格式化还得继续）', async () => {
        githubMocks.listBackups.mockRejectedValue(new Error('401 token 失效'));

        const report = await purgeCloudBackups(baseConfig({ provider: 'github', githubToken: 't', githubOwner: 'o' }));

        expect(report.allOk).toBe(false);
        expect(report.steps[0].message).toContain('401');
    });

    it('云同步已登录 → 删 sully_user_data 与 sully_api_secrets 两行', async () => {
        cloudSyncMocks.loadCloudSyncConfig.mockReturnValue({
            supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', autoSync: true,
        });
        cloudSyncMocks.loadCloudSyncSession.mockReturnValue({
            accessToken: 'jwt', refreshToken: 'r', userId: 'u-1', email: 'a@b.c', expiresAt: Date.now() + 60000,
        });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
        vi.stubGlobal('fetch', fetchMock);

        const report = await purgeCloudBackups(baseConfig({ provider: 'backend' }));
        backendMocks.isBackendBackupReady.mockReturnValue(false);

        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('sully_user_data') && u.includes('u-1'))).toBe(true);
        expect(urls.some((u) => u.includes('sully_api_secrets'))).toBe(true);
        expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit).method === 'DELETE')).toBe(true);
        expect(report.steps.some((s) => s.label === '云同步' && s.ok)).toBe(true);
    });

    it('云同步配了但没登录 → 明确报「云端快照没清」', async () => {
        cloudSyncMocks.loadCloudSyncConfig.mockReturnValue({
            supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', autoSync: true,
        });
        cloudSyncMocks.loadCloudSyncSession.mockReturnValue(null);
        backendMocks.isBackendBackupReady.mockReturnValue(false);

        const report = await purgeCloudBackups(baseConfig({ provider: 'backend' }));

        const sync = report.steps.find((s) => s.label === '云同步');
        expect(sync?.ok).toBe(false);
        expect(sync?.message).toContain('没清');
        expect(report.allOk).toBe(false);
    });

    it('什么都没配 → 单条「跳过」结论且 allOk', async () => {
        const report = await purgeCloudBackups(baseConfig({ provider: undefined }));
        expect(report.allOk).toBe(true);
        expect(report.steps).toHaveLength(1);
    });
});
