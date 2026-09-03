import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';
import {
    CLOUD_SYNC_INIT_SQL,
    cloudSyncLogin,
    cloudSyncLogout,
    cloudSyncPeek,
    cloudSyncProbeTable,
    cloudSyncPull,
    cloudSyncPush,
    cloudSyncSignUp,
    loadCloudSyncConfig,
    loadCloudSyncSession,
    saveCloudSyncConfig,
    type CloudSyncConfig,
} from '../../utils/cloudSync';

/**
 * 云端账号同步面板（设置页）。
 *
 * GitHub Pages + Supabase 模式：注册/登录账号 → 全量备份（含 API 配置，
 * 与「设置 → 导出备份」同口径的 text_only zip）推到自己的 Supabase；
 * 换设备登录后一键拉回，走手动导入同一条恢复管道。
 * 数据行 RLS 按 auth.uid() 隔离，anon key 拿不到任何人的数据。
 * 与「云端备份（WebDAV/GitHub Releases）」「自主后端」并存。
 */

const fmtBytes = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`;
const fmtTime = (ts: number) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const CloudSyncSettings: React.FC = () => {
    const { exportSystem, importSystem, addToast } = useOS();
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState<CloudSyncConfig>(() => loadCloudSyncConfig());
    const [session, setSession] = useState(() => loadCloudSyncSession());
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    // 加密口令：登录/注册时从密码框带入，之后只在 React 内存态（不进 localStorage/sessionStorage）。
    // 页面刷新后为空 → 上传/恢复前要求重新输入一次（解锁语义，与密码管理器锁屏同思路）。
    // 自动上传链路读 sessionStorage 的会话级副本（关浏览器即清，不落磁盘）。
    const [cryptoPassword, setCryptoPassword] = useState(() => {
        try { return sessionStorage.getItem('os_cloud_sync_pass_v1') || ''; } catch { return ''; }
    });
    const [mode, setMode] = useState<'login' | 'signup'>('login');
    const [busy, setBusy] = useState<string | null>(null);
    const [status, setStatus] = useState('');
    const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
    const [remote, setRemote] = useState<{ rawBytes: number; gzipBytes: number; deviceLabel: string; pushedAt: number } | null>(null);
    const [showSql, setShowSql] = useState(false);

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
            setCryptoPassword(password); // 登录口令同场转加密口令（只在内存，不落盘）
            // 自动上传（页面隐藏时静默 push）需要口令派生密钥——缓存在 sessionStorage：
            // 刷新页面仍在（同浏览器会话内自动同步连续），关浏览器即清，不写磁盘。
            try { sessionStorage.setItem('os_cloud_sync_pass_v1', password); } catch { /* 隐私模式等场景静默跳过 */ }
            trackEvent(mode === 'signup' ? '云同步注册' : '云同步登录');
            addToast(mode === 'signup' ? '注册并登录成功' : '登录成功', 'success');
        } catch (e) {
            setStatus(`❌ ${e instanceof Error ? e.message : '操作失败'}`);
        } finally {
            setBusy(null);
        }
    };

    const handlePush = async () => {
        if (!session) return;
        setBusy('push');
        setStatus('');
        try {
            trackEvent('云同步上传');
            // 与「设置 → 导出备份」完全同口径（text_only 档：全部数据 + 设置，
            // 媒体二进制不带——图片走 blobref 令牌，恢复端由 blob_assets 本地解析）。
            const zipBlob = await exportSystem('text_only');
            const { rawBytes, gzipBytes } = await cloudSyncPush(config, session, {
                zipBlob,
                password: cryptoPassword,
                onProgress: msg => setStatus(msg),
            });
            setStatus(`✅ 已加密上传：原始 ${fmtBytes(rawBytes)} → 密文 gzip 后 ${fmtBytes(gzipBytes)}`);
            addToast('云端备份已更新（端到端加密）', 'success');
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
        if (!window.confirm('将用云端备份覆盖本机当前全部数据（角色、聊天、设置、API 配置都会被替换）。确定继续？')) return;
        setBusy('pull');
        setStatus('');
        try {
            trackEvent('云同步恢复');
            const zipBlob = await cloudSyncPull(config, session, cryptoPassword, msg => setStatus(msg));
            // 走与手动导入 zip 完全相同的管道（含分片校验与进度 UI）
            await importSystem(new File([zipBlob], 'sully_cloud_sync.zip', { type: 'application/zip' }));
            setStatus('✅ 已解密并从云端恢复，刷新后生效');
            addToast('云端数据已恢复', 'success');
        } catch (e) {
            setStatus(`❌ ${e instanceof Error ? e.message : '恢复失败'}`);
        } finally {
            setBusy(null);
        }
    };

    const handleLogout = () => {
        cloudSyncLogout();
        setSession(null);
        setRemote(null);
        setCryptoPassword('');
        try { sessionStorage.removeItem('os_cloud_sync_pass_v1'); } catch { /* ignore */ }
        addToast('已退出云同步账号（云端数据保留）', 'info');
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
                    用你自己的 Supabase 账号存档：注册登录即对应你的全部数据（角色、聊天、设置、API 配置），换设备登录后一键拉回无缝继续。数据行按账号行级隔离，100% 在你自己手里。与「云端备份」「自主后端」并存互不影响。
                </p>

                {/* 快捷部署链接 */}
                <div className="rounded-2xl bg-violet-50/60 border border-violet-100 p-3 space-y-2">
                    <div className="text-[10px] font-bold text-violet-500 uppercase tracking-widest">快速开始（只需一次）</div>
                    <ol className="text-[11px] text-slate-600 leading-relaxed list-decimal list-inside space-y-1">
                        <li>注册 <a href="https://supabase.com" target="_blank" rel="noreferrer" className="text-violet-500 font-bold underline underline-offset-2">supabase.com</a>（免费套餐即可）并新建项目</li>
                        <li>项目设置 → API 里复制 <b>项目地址</b>和 <b>anon key</b> 填到下面</li>
                        <li>点「查看初始化 SQL」复制，到 Supabase 的 <b>SQL Editor</b> 粘贴运行（建表 + 定时心跳，一键完成）</li>
                    </ol>
                    <button onClick={() => { setShowSql(v => !v); if (!showSql) trackEvent('查看云同步初始化SQL'); }} className="w-full py-2 rounded-xl text-[11px] font-bold text-violet-600 bg-white border border-violet-200 hover:bg-violet-50 transition-colors">
                        {showSql ? '收起初始化 SQL' : '查看初始化 SQL'}
                    </button>
                    <p className="text-center text-[10px] text-slate-400">完整部署指南见仓库 <span className="font-mono">docs/cloud-sync-setup.md</span></p>
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

                {/* 连接配置 */}
                <label className="block">
                    <span className="mb-1.5 block text-[10px] font-bold text-slate-500">Supabase 项目地址</span>
                    <input value={config.supabaseUrl} onChange={e => persistConfig({ ...config, supabaseUrl: e.target.value })} placeholder="https://xxxx.supabase.co" spellCheck={false} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
                </label>
                <label className="block">
                    <span className="mb-1.5 block text-[10px] font-bold text-slate-500">anon key</span>
                    <input value={config.supabaseAnonKey} onChange={e => persistConfig({ ...config, supabaseAnonKey: e.target.value })} placeholder="项目设置 → API → anon public" type="password" spellCheck={false} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
                </label>
                <div className="flex gap-2">
                    <button onClick={runProbe} disabled={busy === 'probe' || !connected} className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${connected ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50' : 'bg-slate-100 text-slate-300'}`}>
                        {busy === 'probe' ? '探测中…' : '测试连接'}
                    </button>
                    <label className="flex items-center gap-2 px-3 rounded-xl border border-slate-200 bg-white text-xs text-slate-600 cursor-pointer">
                        <input type="checkbox" checked={config.autoSync} onChange={e => persistConfig({ ...config, autoSync: e.target.checked })} className="accent-violet-500" />
                        自动上传
                    </label>
                </div>
                {probe && (
                    <p className={`text-[11px] leading-relaxed px-3 py-2 rounded-xl ${probe.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{probe.ok ? '✅ ' : '⚠️ '}{probe.message}</p>
                )}

                {connected && (
                    <div className="h-px bg-slate-100" />
                )}

                {/* 账号登录/注册 */}
                {connected && !session && (
                    <div className="space-y-2.5 rounded-2xl bg-slate-50/70 border border-slate-100 p-3">
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

                {/* 已登录：云端状态 + 推/拉 */}
                {connected && session && (
                    <div className="space-y-2.5">
                        <div className="rounded-2xl bg-slate-50/70 border border-slate-100 p-3 text-[11px] text-slate-600 space-y-1">
                            <div className="flex justify-between"><span className="text-slate-400">账号</span><span className="font-bold">{session.email}</span></div>
                            <div className="flex justify-between"><span className="text-slate-400">云端备份</span><span className="font-bold">{remote ? `${fmtBytes(remote.gzipBytes)} · ${fmtTime(remote.pushedAt)}` : '还没有'}</span></div>
                            {remote?.deviceLabel && <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">最后上传设备</span><span className="truncate font-mono text-slate-500">{remote.deviceLabel}</span></div>}
                        </div>
                        {session && !cryptoPassword && (
                            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-3 space-y-2">
                                <p className="text-[10px] text-amber-600 leading-relaxed">
                                    🔒 备份采用端到端加密（AES-256-GCM，密钥由你的账号密码在浏览器内派生），口令不落盘、页面刷新后即锁定。请重新输入一次账号密码解锁上传/恢复：
                                </p>
                                <div className="flex gap-2">
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder="账号密码（解锁加密）"
                                        className="flex-1 bg-white border border-amber-200 rounded-xl px-3 py-2 text-[11px] outline-none focus:border-amber-400"
                                    />
                                    <button
                                        onClick={() => {
                                            if (!password) { addToast('请输入账号密码', 'error'); return; }
                                            setCryptoPassword(password);
                                            try { sessionStorage.setItem('os_cloud_sync_pass_v1', password); } catch { /* ignore */ }
                                            addToast('已解锁端到端加密', 'success');
                                        }}
                                        className="px-4 py-2 rounded-xl text-[11px] font-bold bg-amber-400 text-white shadow-sm active:scale-95 transition-all"
                                    >
                                        解锁
                                    </button>
                                </div>
                            </div>
                        )}
                        <div className="flex gap-2">
                            <button onClick={handlePush} disabled={busy === 'push' || !cryptoPassword} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white shadow-sm shadow-violet-200 active:scale-95 transition-all disabled:opacity-50">
                                {busy === 'push' ? '加密上传中…' : '⬆ 加密上传本机数据'}
                            </button>
                            <button onClick={handlePull} disabled={busy === 'pull' || !cryptoPassword} className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-white border border-violet-200 text-violet-600 hover:bg-violet-50 active:scale-95 transition-all disabled:opacity-50">
                                {busy === 'pull' ? '解密恢复中…' : '⬇ 解密恢复到本机'}
                            </button>
                        </div>
                        <button onClick={handleLogout} className="w-full py-2 rounded-xl text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors">退出登录（云端数据保留）</button>
                    </div>
                )}

                {status && (
                    <p className="text-[11px] text-slate-500 leading-relaxed px-3 py-2 rounded-xl bg-slate-50 break-words">{status}</p>
                )}
                <p className="text-[10px] text-slate-400 leading-relaxed">
                    上传内容 = 「设置 → 导出备份」的文本档（含 API 配置与全部设置；图片视频等媒体不入云，恢复后由本机相册/媒体库对应），整包经你的账号密码派生密钥（PBKDF2·21 万次）做 AES-256-GCM 端到端加密后才离开浏览器——数据库被拖库也只见密文，Supabase 与本站代码里都没有明文密钥。免费套餐 500MB 对个人足够；接近上限会提前提醒。心跳每 30 分钟自动打点，防止免费项目 7 天无活动被暂停。
                </p>
            </div>}
        </section>
    );
};

export default CloudSyncSettings;
