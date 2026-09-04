/**
 * backendBackupClient.ts
 * 「本地 backend git 仓库」备份通道的客户端（provider='backend'）。
 *
 * 用户定调（2026-09-04 方向变更）：密钥只走 sully_settings，永远不进 git 仓库；
 * 其他所有数据由 backend 把脱敏 zip 解成 JSON 文件树并自动 git commit——历史即备份。
 *
 * 与 webdavClient/githubClient 同一份五函数契约（uploadBackup / listBackups /
 * downloadBackup / deleteBackup / cleanupOldBackups + testConnection），挂进
 * OSContext 的 loadBackupProvider 即可被手动备份、自动备份（githubAutoBackup 调度器）
 * 与自动恢复（autoRestore）三处复用。地址与令牌不在 CloudBackupConfig 里——复用
 * 「自主后端」面板的 sullyos_backend_chat_v1（backendClient.loadBackendChatConfig），
 * 一处配置两处用。
 */

import type { CloudBackupConfig, CloudBackupFile } from '../types';
import { loadBackendChatConfig } from './backendClient';

/** backend 服务端响应统一 { data, error, message, details }；这里只关心 data/error。 */
async function backendFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const { baseUrl, token } = loadBackendChatConfig();
    if (!token) throw new Error('本地后端未配置令牌，请先在「自主后端」面板完成配置');
    const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            ...(init?.headers || {}),
            authorization: `Bearer ${token}`,
        },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const details = Array.isArray((body as any).details) ? `：${(body as any).details.join('；')}` : '';
        // 注意 + 优先级高于 ||：base 先落定，details 再拼尾巴（拒收原因一条不能丢）
        const base = (body as any).message || (body as any).error || `本地后端请求失败 (${res.status})`;
        throw new Error(base + details);
    }
    return (body as { data: T }).data;
}

/** 配置健全性：backend 通道要求「自主后端」已有地址+令牌（provider 判定各处共用）。 */
export function isBackendBackupReady(): boolean {
    const { baseUrl, token } = loadBackendChatConfig();
    return !!(baseUrl && baseUrl.trim() && token && token.trim());
}

export const testConnection = async (_config: CloudBackupConfig): Promise<{ ok: boolean; message: string }> => {
    try {
        const status = await backendFetch<{ exists: boolean; latestCommit: string | null; fileCount: number }>(
            '/v1/backup/status',
        );
        return {
            ok: true,
            message: status.latestCommit
                ? `已连接本地后端（备份仓库 ${status.fileCount} 个文件）`
                : '已连接本地后端（备份仓库还是空的，备份一次后就有历史）',
        };
    } catch (e: any) {
        return { ok: false, message: e?.message || '本地后端连接失败' };
    }
};

export const uploadBackup = async (
    _config: CloudBackupConfig,
    blob: Blob,
    _filename: string,
    _onProgress?: (percent: number) => void,
): Promise<{ ok: boolean; message: string }> => {
    try {
        const { baseUrl, token } = loadBackendChatConfig();
        if (!token) throw new Error('本地后端未配置令牌');
        const res = await fetch(`${baseUrl}/v1/backup/upload`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
            body: blob,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const details = Array.isArray((body as any).details) ? `：${(body as any).details.join('；')}` : '';
            const base = (body as any).message || (body as any).error || `上传失败 (${res.status})`;
            return { ok: false, message: base + details };
        }
        const data = (body as { data: { committed: boolean; commit: string | null; fileCount: number } }).data;
        return {
            ok: true,
            message: data.committed
                ? `已提交到本地 git 仓库（${String(data.commit).slice(0, 8)}，${data.fileCount} 个文件）`
                : '内容无变化，未产生新提交',
        };
    } catch (e: any) {
        return { ok: false, message: e?.message || '本地后端上传失败' };
    }
};

export const listBackups = async (_config: CloudBackupConfig): Promise<CloudBackupFile[]> => {
    const files = await backendFetch<CloudBackupFile[]>('/v1/backup/history?limit=20');
    return files;
};

export const downloadBackup = async (
    _config: CloudBackupConfig,
    _file: CloudBackupFile,
    _onProgress?: (percent: number) => void,
): Promise<Blob | null> => {
    try {
        const { baseUrl, token } = loadBackendChatConfig();
        const res = await fetch(`${baseUrl}/v1/backup/download`, {
            headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        return await res.blob();
    } catch {
        return null;
    }
};

/** git 历史就是要保留的备份历史——backend 通道不做删除。 */
export const deleteBackup = async (_config: CloudBackupConfig, _file: CloudBackupFile): Promise<boolean> => {
    return true;
};

/** 同上：git 仓库的 cleanup 是伪操作，永远成功且不删任何提交。 */
export const cleanupOldBackups = async (_config: CloudBackupConfig, _keepCount = 5): Promise<number> => {
    return 0;
};

/** 启动/回前台时的「有没有新提交」检查（OSContext 备份状态效应用）。 */
export async function fetchBackupStatus(): Promise<{
    exists: boolean;
    latestCommit: string | null;
    commitTime: string | null;
    fileCount: number;
    sizeBytes: number;
} | null> {
    try {
        return await backendFetch('/v1/backup/status');
    } catch {
        return null;
    }
}
