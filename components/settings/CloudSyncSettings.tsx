import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';
import { setCheckPhoneApi } from '../../utils/checkPhoneApi';
import { importAmsg2GlobalConfig } from '../../utils/activeMsgStore';
import {
    CLOUD_SYNC_INIT_SQL,
    cloudSyncLogin,
    cloudSyncLogout,
    cloudSyncPeek,
    cloudSyncProbeTable,
    cloudSyncPull,
    cloudSyncPullSecrets,
    cloudSyncPush,
    cloudSyncSignUp,
    forgetSecretKey,
    loadCloudSyncConfig,
    loadCloudSyncSession,
    mergeBackupSecrets,
    resolveSecretKey,
    saveCloudSyncConfig,
    splitBackupSecrets,
    type CloudSyncConfig,
} from '../../utils/cloudSync';

/**
 * 云端账号同步面板（设置页）。
 *
 * 目标体验（用户原话）：「把所有数据都存在云端…点开就是之前发的消息，不用再导入信息」。
 * 邮箱+密码登录一次 → 角色/聊天/设置明文同步（RLS 行级隔离），API 密钥另用
 * 账号密码派生的可复用密钥加密（密钥不可导出地存在本机 IndexedDB，密码不落盘）
 * → 之后每次打开都自动拉最新、自动解密，全程零手动步骤。
 */

const fmtBytes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`;
const fmtTime = (ts: number) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const CloudSyncSettings: React.FC = () => {
    const { exportSystem, importSystem, addToast, characters, updateApiConfig, setAvailableModels, apiPresets,
        addApiPreset, updateApiPreset, removeApiPreset } = useOS();
    // 预设写入走与手动导入同一口径：normalize → state → localStorage（add/update/
    // remove 每个 action 内部都自带 normalize + setApiPresets + 落盘的完整管道）。
    const savePresetsLocal = (presets: any[]) => {
        const nextIds = new Set(presets.map((p: any) => p?.id).filter(Boolean));
        for (const existing of apiPresets) {
            if (!nextIds.has(existing.id)) removeApiPreset(existing.id);
        }
        for (const p of presets) {
            const existing = apiPresets.find(e => e.id === p?.id);
            if (existing) updateApiPreset(p.id, p.name || existing.name, p.config || existing.config);
            else addApiPreset(p.name || '预设', p.config);
        }
    };
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState<CloudSyncConfig>(() => loadCloudSyncConfig());
    const [session, setSession] = useState(() => loadCloudSyncSession());
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [mode, setMode] = useState<'login' | 'signup'>('login');
    const [busy, setBusy] = useState<string | null>(null);
    const [status, setStatus] = useState('');
    const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
    const [remote, setRemote] = useState<{ rawBytes: number; gzipBytes: number; deviceLabel: string; pushedAt: number } | null>(null);
    const [showSql, setShowSql] = useState(false);
    // 本机是否已有解密钥匙（登录时派生、不可导出地存在 IndexedDB）。有 = 平时全自动，
    // 不需要任何密码；没有（老用户第一次升级 / 清过数据）= 提示登录一次即可。
    const [keyReady, setKeyReady] = useState(false);
    useEffect(() => {
        if (!session?.userId) { setKeyReady(false); return; }
        let cancelled = false;
        void resolveSecretKey(session.userId).then(k => { if (!cancelled) setKeyReady(Boolean(k)); });
        return () => { cancelled = true; };
    }, [session?.userId]);

    const persistConfig = (next: CloudSyncConfig) => {
        setConfig(next);
        saveCloudSyncConfig(next);
        return next;
    };

    // 已登录时刷新云端快照信息
    useEffect(() => {
        if (!open || !session || !config.supabaseUrl || !config.supabaseAnonKey) return;
        let cancelled = false;
        cloudSyncPeek(config, session)
            .then(meta => { if (!cancelled) setRemote(meta); })
            .catch(() => { if (!cancelled) setRemote(null); });
        return () => { cancelled = true; };
    }, [open, session, config.supabaseUrl, config.supabaseAnonKey]);

    const runProbe = async () => {
        setBusy('probe');
        try {
            const result = await cloudSyncProbeTable(config);
            setProbe(result);
        } catch (e) {
            setProbe({ ok: false, message: e instanceof Error ? e.message : '探测失败' });
        } finally {
            setBusy(null);
        }
    };

    const handleAuth = async () => {
        setBusy('auth');
        setStatus('');
        try {
            const next = mode === 'signup'
                ? await cloudSyncSignUp(config, email.trim(), password)
                : await cloudSyncLogin(config, email.trim(), password);
            setSession(next);
            // 登录密码 → 派生可复用密钥（不可导出，存本机 IndexedDB）：
            // 之后每次打开页面都能自动解开云端的 API 密钥，不用再输密码。
            // 密码本身不落任何存储。
            const secretKey = await resolveSecretKey(next.userId, password);
            setKeyReady(Boolean(secretKey));
            // 自动同步默认开——用户要的是「点开就是上次的状态」
            const cfg = persistConfig({ ...config, autoSync: true });
            trackEvent(mode === 'signup' ? '云同步注册' : '云同步登录');
            addToast(mode === 'signup' ? '注册并登录成功' : '登录成功', 'success');

            // —— 登录即同步（无感）：云端比本机新就把云端的全部数据（含 API 密钥）拉回来 ——
            setBusy('sync');
            void (async () => {
                try {
                    const meta = await cloudSyncPeek(cfg, next).catch(() => null);
                    const lastLocalSync = Number(localStorage.getItem('os_cloud_sync_last_push_v1') || '0');
                    // 云端有数据且不是本机最后推的那份 → 拉回（换设备/换浏览器都走这条）
                    if (meta && meta.pushedAt > lastLocalSync) {
                        setStatus('正在从云端同步你的数据…');
                        const dataZip = await cloudSyncPull(cfg, next, password, msg => setStatus(msg));
                        let finalZip = dataZip;
                        const { secretsJson } = await cloudSyncPullSecrets(cfg, next, password);
                        if (secretsJson) finalZip = await mergeBackupSecrets(dataZip, secretsJson);
                        await importSystem(new File([finalZip], 'sully_cloud_sync.zip', { type: 'application/zip' }));
                        addToast('云端数据已同步（含 API 配置）', 'success');
                        setStatus('✅ 数据已回来，即将刷新生效');
                        setTimeout(() => window.location.reload(), 1200);
                        return;
                    }
                    // 云端为空 / 本机就是最新：推一份上去（数据明文 + API 密钥加密）
                    setStatus('正在备份数据到云端…');
                    const zipBlob = await exportSystem('text_only');
                    const { publicZip, secretsJson } = await splitBackupSecrets(zipBlob);
                    const { gzipBytes } = await cloudSyncPush(cfg, next, { zipBlob: publicZip, secretsJson, secretKey, onProgress: msg => setStatus(msg) });
                    setStatus(`✅ 已同步到云端（${fmtBytes(gzipBytes)}），之后全自动，换设备登录数据自己回来`);
                    const freshMeta = await cloudSyncPeek(cfg, next).catch(() => null);
                    if (freshMeta) setRemote(freshMeta);
                } catch (e) {
                    setStatus(`⚠️ 自动同步未完成：${e instanceof Error ? e.message : '未知错误'}（数据仍在本地，可在下方手动重试）`);
                } finally {
                    setBusy(null);
                }
            })();
        } catch (e) {
            setStatus(`❌ ${e instanceof Error ? e.message : '操作失败'}`);
            setBusy(null);
        }
    };

    const handlePush = async () => {
        if (!session) return;
        setBusy('push');
        setStatus('');
        try {
            trackEvent('云同步上传');
            // 与「设置 → 导出备份」完全同口径（text_only 档），敏感字段拆出单独加密上传。
            const zipBlob = await exportSystem('text_only');
            const { publicZip, secretsJson } = await splitBackupSecrets(zipBlob);
            const secretKey = await resolveSecretKey(session.userId);
            const { rawBytes, gzipBytes } = await cloudSyncPush(config, session, {
                zipBlob: publicZip,
                secretsJson,
                secretKey,
                onProgress: msg => setStatus(msg),
            });
            setStatus(`✅ 已上传：原始 ${fmtBytes(rawBytes)} → gzip 后 ${fmtBytes(gzipBytes)}${secretKey ? '（API 密钥已加密随行）' : '（本机没有钥匙，API 密钥未更新——重新登录一次即可）'}`);
            addToast('云端数据已更新', 'success');
            const meta = await cloudSyncPeek(config, session).catch(() => null);
            setRemote(meta);
        } catch (e) {
            setStatus(`❌ ${e instanceof Error ? e.message : '上传失败'}`);
        } finally {
            setBusy(null);
        }
    };

    const handlePull = async () => {
        if (!session) return;
        if (!window.confirm('将用云端数据覆盖本机当前全部数据（角色、聊天、设置都会被替换）。确定继续？')) return;
        setBusy('pull');
        setStatus('');
        try {
            trackEvent('云同步恢复');
            const dataZip = await cloudSyncPull(config, session, '', msg => setStatus(msg));
            let finalZip = dataZip;
            const { secretsJson } = await cloudSyncPullSecrets(config, session).catch(() => ({ secretsJson: null as string | null }));
            if (secretsJson) finalZip = await mergeBackupSecrets(dataZip, secretsJson);
            // 走与手动导入 zip 完全相同的管道（含分片校验与进度 UI）
            await importSystem(new File([finalZip], 'sully_cloud_sync.zip', { type: 'application/zip' }));
            setStatus('✅ 已从云端恢复，刷新后生效');
            addToast('云端数据已恢复', 'success');
        } catch (e) {
            setStatus(`❌ ${e instanceof Error ? e.message : '恢复失败'}`);
        } finally {
            setBusy(null);
        }
    };

    const handleLogout = async () => {
        cloudSyncLogout();
        await forgetSecretKey();   // 本机钥匙一起清掉：退出后这台机器再也解不开云端密钥
        setSession(null);
        setRemote(null);
        setKeyReady(false);
        addToast('已退出云同步账号（云端数据保留）', 'info');
    };

    // ── 同步 API 配置到本机 ──
    // 平时不用点：登录后每次打开页面都会自动拉。这个入口用于两种情况：
    //   1. 刚在另一台设备改了配置，想立刻拿过来
    //   2. 本机还没有解密钥匙（旧版本时期登录的设备）→ 传一次账号密码把钥匙补上，
    //      之后这台设备永久免密。
    const handleSyncKeys = async (passwordOnce?: string) => {
        if (!session) return;
        setBusy('keys');
        setStatus('');
        try {
            trackEvent('云同步拉取密钥');
            if (passwordOnce) {
                const k = await resolveSecretKey(session.userId, passwordOnce);
                setKeyReady(Boolean(k));
            }
            const { secretsJson, locked } = await cloudSyncPullSecrets(config, session, passwordOnce);
            if (locked) {
                setStatus(passwordOnce
                    ? '❌ 密码不对，解不开云端的 API 配置（就是你注册/登录用的那个密码）'
                    : '❌ 本机还没有解密钥匙：在上面输入一次账号密码即可（只需一次，之后永久免密）');
                return;
            }
            if (!secretsJson || secretsJson === '{}') {
                setStatus('云端还没有 API 配置——本机配好后切走一次页面（或点下方手动上传）就会自动推上去');
                return;
            }
            const secrets = JSON.parse(secretsJson) as Record<string, any>;
            const applied: string[] = [];

            // API 主配置 + 模型列表（配套走，没模型列表恢复后下拉会空）
            if (secrets.apiConfig) {
                updateApiConfig(secrets.apiConfig as any);
                applied.push('API 配置');
            }
            if (Array.isArray(secrets.availableModels) && secrets.availableModels.length > 0) {
                setAvailableModels(secrets.availableModels);
                applied.push('模型列表');
            }
            // API 预设：savePresets 走 normalize + localStorage + state，与手动导入同管道
            if (Array.isArray(secrets.apiPresets)) {
                savePresetsLocal(secrets.apiPresets);
                applied.push(`API 预设 ×${secrets.apiPresets.length}`);
            }
            if (secrets.checkPhoneApi !== undefined) {
                setCheckPhoneApi(secrets.checkPhoneApi ?? null);
                applied.push('查岗 API');
            }
            // 纯 localStorage 的小配置：直接回填各自键
            const lsMap: Array<[string, string]> = [
                ['studyApiConfig', 'study_api_config'],
                ['instantPushConfig', 'instant_push_config_v1'],
                ['pushVapid', 'push_vapid_v1'],
                ['cloudBackupConfig', 'os_cloud_backup_config'],
            ];
            for (const [field, lsKey] of lsMap) {
                if (secrets[field] !== undefined) {
                    localStorage.setItem(lsKey, JSON.stringify(secrets[field]));
                    applied.push(lsKey);
                }
            }
            // 主动消息 2.0 全局配置存独立 IndexedDB（ActiveMsg 库）
            if (secrets.amsg2GlobalConfig) {
                await importAmsg2GlobalConfig(secrets.amsg2GlobalConfig);
                applied.push('主动消息配置');
            }

            // 触发一次 lsMirror 快照，让刚写入的 os_api_config 等键立即有 IndexedDB 兜底
            import('../../utils/lsMirror').then(m => m.snapshotLocalStorageMirror()).catch(() => {});

            if (applied.length === 0) {
                setStatus('云端这份配置里没有可识别的字段（旧版本推的），本机配好后再上传一次即可');
            } else {
                setStatus(`✅ 已同步到本机：${applied.join('、')}。API 请求仍从本机浏览器直发，刷新页面后全部生效`);
                addToast('云端 API 配置已同步到本机', 'success');
            }
        } catch (e) {
            setStatus(`❌ ${e instanceof Error ? e.message : '同步密钥失败'}`);
        } finally {
            setBusy(null);
        }
    };

    const connected = Boolean(config.supabaseUrl && config.supabaseAnonKey);

    return (
        <section className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5 3 11.25l3.75 3.75m10.5-7.5 3.75 3.75-3.75 3.75M9 3.75h6m-6 16.5h6M12 3v4.5M12 16.5V21" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">云端账号同步</h2>
                    <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full ${connected ? (session ? 'bg-violet-100 text-violet-600' : 'bg-amber-100 text-amber-600') : 'bg-slate-100 text-slate-400'}`}>
                        {connected ? (session ? '已登录' : '未登录') : '未配置'}
                    </span>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
            </div>

            {open && <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed">
                    邮箱+密码登录一次，全部数据（聊天、角色、设置、API 配置）就都在云端了。换设备/换浏览器登录同一账号，打开就是上次的样子——不用导入、不用输第二次密码。
                </p>

                {/* 连接配置：内置官方服务器，默认无需填写；收进折叠里供自部署用户替换 */}
                <details className="rounded-2xl bg-slate-50/70 border border-slate-100">
                    <summary className="px-3 py-2 text-[11px] font-bold text-slate-400 cursor-pointer select-none">自部署服务器（可选，默认用内置）</summary>
                    <div className="p-3 pt-0 space-y-2">
                        <label className="block">
                            <span className="mb-1.5 block text-[10px] font-bold text-slate-500">Supabase 项目地址</span>
                            <input value={config.supabaseUrl} onChange={e => persistConfig({ ...config, supabaseUrl: e.target.value })} placeholder="https://xxxx.supabase.co" spellCheck={false} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
                        </label>
                        <label className="block">
                            <span className="mb-1.5 block text-[10px] font-bold text-slate-500">anon key</span>
                            <input value={config.supabaseAnonKey} onChange={e => persistConfig({ ...config, supabaseAnonKey: e.target.value })} placeholder="项目设置 → API → anon public" type="password" spellCheck={false} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
                        </label>
                        <button onClick={runProbe} disabled={busy === 'probe' || !connected} className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all ${connected ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50' : 'bg-slate-100 text-slate-300'}`}>
                            {busy === 'probe' ? '探测中…' : '测试连接'}
                        </button>
                        {probe && (
                            <p className={`text-[11px] leading-relaxed px-3 py-2 rounded-xl ${probe.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{probe.ok ? '✅ ' : '⚠️ '}{probe.message}</p>
                        )}
                        <p className="text-[10px] text-slate-400 leading-relaxed">自部署：注册 <a href="https://supabase.com" target="_blank" rel="noreferrer" className="text-violet-500 underline underline-offset-2">supabase.com</a> 新建项目，点「查看初始化 SQL」在 SQL Editor 运行一次。</p>
                        <button onClick={() => { setShowSql(v => !v); if (!showSql) trackEvent('查看云同步初始化SQL'); }} className="w-full py-2 rounded-xl text-[11px] font-bold text-violet-600 bg-white border border-violet-200 hover:bg-violet-50 transition-colors">
                            {showSql ? '收起初始化 SQL' : '查看初始化 SQL'}
                        </button>
                        {showSql && (
                            <div className="space-y-2">
                                <pre className="max-h-48 overflow-auto rounded-xl bg-slate-900 text-slate-100 text-[9px] leading-relaxed p-3 whitespace-pre-wrap">{CLOUD_SYNC_INIT_SQL}</pre>
                                <button
                                    onClick={() => { navigator.clipboard.writeText(CLOUD_SYNC_INIT_SQL).then(() => addToast('SQL 已复制，去 Supabase SQL Editor 粘贴运行', 'success')).catch(() => addToast('复制失败，请手动选择复制', 'error')); trackEvent('复制云同步初始化SQL'); }}
                                    className="w-full py-2 rounded-xl text-[11px] font-bold text-white bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-200 active:scale-95 transition-all"
                                >
                                    复制 SQL
                                </button>
                            </div>
                        )}
                    </div>
                </details>

                {/* 账号登录/注册 */}
                {connected && !session && (
                    <div className="space-y-2.5 rounded-2xl bg-violet-50/50 border border-violet-100 p-3">
                        <div className="flex gap-2">
                            <button onClick={() => setMode('login')} className={`flex-1 py-1.5 rounded-full text-[11px] font-bold border transition-colors ${mode === 'login' ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'}`}>登录</button>
                            <button onClick={() => setMode('signup')} className={`flex-1 py-1.5 rounded-full text-[11px] font-bold border transition-colors ${mode === 'signup' ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'}`}>注册新账号</button>
                        </div>
                        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="邮箱" type="email" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
                        <input value={password} onChange={e => setPassword(e.target.value)} placeholder="密码（至少 6 位）" type="password" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
                        <button onClick={handleAuth} disabled={busy === 'auth' || !email.trim() || password.length < 6} className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all ${(mode === 'login' || (email.trim() && password.length >= 6)) ? 'bg-violet-500 text-white shadow-sm shadow-violet-200 active:scale-95' : 'bg-violet-200/60 text-white'}`}>
                            {busy === 'auth' ? '请稍候…' : mode === 'signup' ? '注册并登录' : '登录'}
                        </button>
                    </div>
                )}

                {/* 已登录：平时全自动（页面隐藏自动推云端、换设备登录自动拉回），手动操作收进高级 */}
                {connected && session && (
                    <div className="space-y-2.5">
                        <div className="rounded-2xl bg-slate-50/70 border border-slate-100 p-3 text-[11px] text-slate-600 space-y-1">
                            <div className="flex justify-between"><span className="text-slate-400">账号</span><span className="font-bold">{session.email}</span></div>
                            <div className="flex justify-between"><span className="text-slate-400">云端数据</span><span className="font-bold">{remote ? `${fmtBytes(remote.gzipBytes)} · ${fmtTime(remote.pushedAt)}` : '还没有'}</span></div>
                            {remote?.deviceLabel && <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">最后同步设备</span><span className="truncate font-mono text-slate-500">{remote.deviceLabel}</span></div>}
                        </div>
                        {busy === 'sync' && (
                            <div className="rounded-2xl bg-violet-50/70 border border-violet-100 px-3 py-2 text-[11px] text-violet-600 font-bold animate-pulse">
                                {status || '正在自动同步…'}
                            </div>
                        )}

                        {/* 状态说明 + 兜底的「立刻拉一次」按钮（平时不用点，打开页面就自动同步） */}
                        <div className="rounded-2xl bg-sky-50/50 border border-sky-100 p-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-sky-100/70 rounded-lg text-sky-600 shrink-0">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-3.5 h-3.5">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a4.5 4.5 0 0 1 0 9m3.75-9a8.25 8.25 0 0 1 0 18M4.5 12h6m-3-3 3 3-3 3" />
                                    </svg>
                                </div>
                                <p className="text-[10px] text-slate-500 leading-relaxed flex-1">
                                    {keyReady
                                        ? '全部数据（聊天、角色、设置、API 配置）都在云端。打开页面即自动拉最新、离开页面即自动上传，不需要任何手动步骤。API 请求始终由本机浏览器直接发出。'
                                        : '这台设备还没有解密钥匙（在旧版本时期登录的）：在下面输入一次账号密码，就能把云端的 API 配置解下来，之后这台设备永久免密自动同步。'}
                                </p>
                            </div>
                            {!keyReady && (
                                <input
                                    type="password"
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                    placeholder="账号密码（只需输一次）"
                                    className="w-full bg-white border border-sky-200 rounded-xl px-3 py-2 text-[11px] outline-none focus:border-sky-400"
                                />
                            )}
                            <button
                                onClick={() => void handleSyncKeys(keyReady ? undefined : password)}
                                disabled={busy === 'keys' || (!keyReady && !password)}
                                className="w-full py-2.5 rounded-xl text-xs font-bold bg-sky-500 text-white shadow-sm shadow-sky-200 active:scale-95 transition-all disabled:opacity-50"
                            >
                                {busy === 'keys' ? '正在同步…' : keyReady ? '立刻同步云端 API 配置到本机' : '解锁并同步 API 配置'}
                            </button>
                        </div>

                        <details className="rounded-2xl bg-slate-50/70 border border-slate-100">
                            <summary className="px-3 py-2 text-[11px] font-bold text-slate-400 cursor-pointer select-none">高级操作（手动上传/恢复）</summary>
                            <div className="p-3 pt-0 space-y-2">
                                <div className="flex gap-2">
                                    <button onClick={handlePush} disabled={busy === 'push'} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white shadow-sm shadow-violet-200 active:scale-95 transition-all disabled:opacity-50">
                                        {busy === 'push' ? '上传中…' : '⬆ 立刻上传本机数据'}
                                    </button>
                                    <button onClick={handlePull} disabled={busy === 'pull'} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-white border border-violet-200 text-violet-600 hover:bg-violet-50 active:scale-95 transition-all disabled:opacity-50">
                                        {busy === 'pull' ? '恢复中…' : '⬇ 用云端覆盖本机'}
                                    </button>
                                </div>
                                <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-[11px] text-slate-600 cursor-pointer">
                                    <input type="checkbox" checked={config.autoSync} onChange={e => persistConfig({ ...config, autoSync: e.target.checked })} className="accent-violet-500" />
                                    自动同步（关掉后打开页面不再自动拉云端数据）
                                </label>
                            </div>
                        </details>
                        <button onClick={handleLogout} className="w-full py-2 rounded-xl text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors">退出登录（云端数据保留）</button>
                    </div>
                )}

                {status && (
                    <p className="text-[11px] text-slate-500 leading-relaxed px-3 py-2 rounded-xl bg-slate-50 break-words">{status}</p>
                )}
                <p className="text-[10px] text-slate-400 leading-relaxed">
                    同步内容 = 「设置 → 导出备份」的文本档（角色、聊天、设置、API 配置全都在；图片视频等媒体不入云，恢复后由本机相册/媒体库对应）。角色与聊天按账号行级隔离存云端（只有你的登录凭据能读写自己那行）；API 密钥这批敏感字段额外用你的账号密码派生密钥（PBKDF2·21 万次）做 AES-256-GCM 加密后才离开浏览器——数据库被拖库也只见密文，密码本身不落任何存储。免费套餐 500MB 对个人足够；接近上限会提前提醒。心跳每 30 分钟自动打点，防止免费项目 7 天无活动被暂停。
                </p>
            </div>}
        </section>
    );
};

export default CloudSyncSettings;
