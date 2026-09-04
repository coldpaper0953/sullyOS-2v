/**
 * purgeCloudBackups.ts
 * 「格式化系统 · 连云端备份一起清」的清空链路。
 *
 * 普通格式化只清本机（IndexedDB + localStorage）；但备份目的地还留着旧快照，
 * 换设备登录/重新配置后数据会被拉回来——用户要的「清干净」必须把远端也清掉。
 *
 * 覆盖三条备份通道 + 云同步两张表：
 *   - provider='github'  → 删掉备份仓库里全部 Release（含中断的分片）
 *   - provider='webdav'  → 删掉备份目录下全部备份文件
 *   - provider='backend' → DELETE /v1/backup/all（文件树 + git 历史）
 *   - Supabase 云同步    → 删 sully_user_data（整包快照）与 sully_api_secrets（逐键密钥）本人行
 *
 * 每一步独立 try/catch：某条通道没配置或连不上，不该阻断其他通道和本机格式化。
 */

import type { CloudBackupConfig } from '../types';

export interface PurgeStepReport {
    /** 通道名，直接给用户看 */
    label: string;
    ok: boolean;
    message: string;
}

export interface PurgeAllReport {
    steps: PurgeStepReport[];
    /** 全部尝试过的通道都成功（没配置的通道不计入失败） */
    allOk: boolean;
}

/** 云端备份 provider 侧：把该 provider 下的全部备份删干净。 */
async function purgeProvider(config: CloudBackupConfig): Promise<PurgeStepReport | null> {
    const provider = config.provider;

    if (provider === 'backend') {
        const { isBackendBackupReady, purgeAllBackups } = await import('./backendBackupClient');
        if (!isBackendBackupReady()) return { label: '本地后端备份', ok: true, message: '未配置，跳过' };
        const r = await purgeAllBackups();
        return { label: '本地后端备份', ...r };
    }

    if (provider === 'github') {
        if (!config.githubToken || !config.githubOwner) {
            return { label: 'GitHub 备份', ok: true, message: '未配置，跳过' };
        }
        const { listBackups, deleteBackup } = await import('./githubClient');
        // listBackups 含 status='incomplete' 的中断分片——清空要一起删，不能像
        // cleanupOldBackups 那样跳过，否则残留分片还挂在 Release 里。
        const files = await listBackups(config);
        if (files.length === 0) return { label: 'GitHub 备份', ok: true, message: '云端本来就没有备份' };
        let deleted = 0;
        for (const file of files) {
            if (await deleteBackup(config, file)) deleted++;
        }
        return {
            label: 'GitHub 备份',
            ok: deleted === files.length,
            message: deleted === files.length
                ? `已删除 ${deleted} 份备份 Release`
                : `删了 ${deleted}/${files.length} 份，剩下的请到仓库 Releases 页手动删`,
        };
    }

    if (provider === 'webdav') {
        if (!config.webdavUrl || !config.username) return { label: 'WebDAV 备份', ok: true, message: '未配置，跳过' };
        const { listBackups, deleteBackup } = await import('./webdavClient');
        const files = await listBackups(config);
        if (files.length === 0) return { label: 'WebDAV 备份', ok: true, message: '云端本来就没有备份' };
        let deleted = 0;
        for (const file of files) {
            if (await deleteBackup(config, file)) deleted++;
        }
        return {
            label: 'WebDAV 备份',
            ok: deleted === files.length,
            message: deleted === files.length ? `已删除 ${deleted} 份备份` : `删了 ${deleted}/${files.length} 份`,
        };
    }

    return null;
}

/** Supabase 云同步：删本人的整包快照行与逐键密钥行（RLS 保证只能删自己的）。 */
async function purgeCloudSync(): Promise<PurgeStepReport | null> {
    const { loadCloudSyncConfig, loadCloudSyncSession } = await import('./cloudSync');
    const config = loadCloudSyncConfig();
    const session = loadCloudSyncSession();
    if (!config?.supabaseUrl || !config?.supabaseAnonKey) return { label: '云同步', ok: true, message: '未配置，跳过' };
    if (!session?.accessToken || !session?.userId) {
        return { label: '云同步', ok: false, message: '未登录，云端快照没清（先登录云同步再重置，或到 Supabase 手动删行）' };
    }

    const base = config.supabaseUrl.replace(/\/+$/, '');
    const headers = {
        apikey: config.supabaseAnonKey,
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
    };
    const results: string[] = [];
    let ok = true;
    for (const table of ['sully_user_data', 'sully_api_secrets']) {
        try {
            const res = await fetch(`${base}/rest/v1/${table}?user_id=eq.${encodeURIComponent(session.userId)}`, {
                method: 'DELETE',
                headers,
            });
            if (res.ok) results.push(`${table} 已清`);
            else { ok = false; results.push(`${table} 失败(HTTP ${res.status})`); }
        } catch (e: any) {
            ok = false;
            results.push(`${table} 失败(${e?.message || '网络错误'})`);
        }
    }
    return { label: '云同步', ok, message: results.join('；') };
}

/**
 * 清空所有远端备份。调用方（Settings 的格式化流程）应在此之前停掉自动备份调度，
 * 之后再执行本机 resetSystem——顺序反了会出现「清完云端又被本机推一次」。
 */
export async function purgeCloudBackups(config: CloudBackupConfig): Promise<PurgeAllReport> {
    const steps: PurgeStepReport[] = [];

    try {
        const providerStep = await purgeProvider(config);
        if (providerStep) steps.push(providerStep);
    } catch (e: any) {
        steps.push({ label: '云端备份', ok: false, message: e?.message || '清空失败' });
    }

    try {
        const syncStep = await purgeCloudSync();
        if (syncStep) steps.push(syncStep);
    } catch (e: any) {
        steps.push({ label: '云同步', ok: false, message: e?.message || '清空失败' });
    }

    if (steps.length === 0) steps.push({ label: '云端', ok: true, message: '没有配置任何云端备份，跳过' });
    return { steps, allOk: steps.every((s) => s.ok) };
}
