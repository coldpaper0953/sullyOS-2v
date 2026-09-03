import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';
import { DB } from '../../utils/db';
import {
    measureStorage,
    runStorageCompaction,
    STORAGE_GUARD_THRESHOLD,
    type StorageUsage,
    type CompactionReport,
} from '../../utils/storageGuard';

/**
 * 存储保护面板（设置页）。
 *
 * 内置存储（IndexedDB）逼近浏览器配额（典型 ~500MB）时，用 AI 把旧聊天记录
 * 分层摘要：越早的消息压得越简、越新的保留越细。摘要成功后原消息删除、纪要
 * 以系统消息留在对话流里——角色仍然记得早期发生过什么。
 *
 * 展示：当前用量/配额水位条；未达标时只报数不动手；达标后可一键压缩，
 * 或等启动自检在后台跑（同一条管线）。
 */

const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

const StorageGuardSettings: React.FC = () => {
    const { characters, apiConfig, addToast } = useOS();
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    const [running, setRunning] = useState(false);
    const [report, setReport] = useState<CompactionReport | null>(null);
    const [open, setOpen] = useState(false);

    const refresh = async () => {
        setUsage(await measureStorage());
    };

    useEffect(() => {
        if (open && !usage) void refresh();
    }, [open, usage]);

    const handleCompact = async () => {
        if (running) return;
        if (!window.confirm('将调用 AI 分层摘要各角色的早期聊天记录（原消息删除、纪要以系统消息保留）。近期对话不动。确定继续？')) return;
        setRunning(true);
        try {
            const rep = await runStorageCompaction(
                characters.map(c => ({ id: c.id, name: c.name, proactiveConfig: (c as any).proactiveConfig, emotionConfig: (c as any).emotionConfig })),
                apiConfig,
                {
                    getCharMessages: charId => DB.getMessagesByCharId(charId, true),
                    deleteMessages: ids => DB.deleteMessages(ids),
                    saveMessage: msg => DB.saveMessage(msg),
                },
                { force: true },
            );
            setReport(rep);
            const total = rep.results.reduce((a, r) => a + r.result.compactedMessages, 0);
            trackEvent('存储保护压缩', { 角色数: rep.results.length, 压缩消息数: total, 结果: rep.results.every(r => r.result.ok) ? '成功' : '部分失败' });
            addToast(total > 0 ? `已压缩 ${total} 条旧消息` : '用量未达阈值或无可压缩内容', total > 0 ? 'success' : 'info');
            await refresh();
        } catch (e) {
            addToast(`压缩失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
        } finally {
            setRunning(false);
        }
    };

    const ratio = usage?.ratio ?? 0;
    const near = ratio >= STORAGE_GUARD_THRESHOLD;
    const barColor = near ? 'bg-rose-400' : ratio >= STORAGE_GUARD_THRESHOLD * 0.7 ? 'bg-amber-400' : 'bg-emerald-400';

    return (
        <section className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    <div className="p-2 bg-amber-100/60 rounded-xl text-amber-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25-2.25M12 13.875V3m-4.5 4.5h9" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">存储保护</h2>
                    <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full ${near ? 'bg-rose-100 text-rose-600' : usage?.supported ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                        {usage?.supported ? (near ? '接近上限' : '健康') : '不可用'}
                    </span>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
            </div>

            {open && <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed">
                    内置存储接近配额（约 500MB）时，用 AI 把早期聊天记录分层摘要：越早的消息压得越简（百字纪要），越新的保留越细，最近 20% 原样保留。摘要以系统消息留在对话里，角色仍记得早期经历。
                </p>

                {usage?.supported && (
                    <div className="rounded-2xl bg-slate-50/70 border border-slate-100 p-3 space-y-2">
                        <div className="flex justify-between text-[11px] text-slate-600">
                            <span className="font-bold">当前用量</span>
                            <span>{fmtMB(usage.usage)} / {fmtMB(usage.quota)}（{(ratio * 100).toFixed(1)}%）</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-200/70 overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400">
                            <span>压缩触发线 {(STORAGE_GUARD_THRESHOLD * 100).toFixed(0)}%</span>
                            <button onClick={refresh} className="font-bold text-slate-400 hover:text-slate-600 active:scale-95 transition-transform">刷新</button>
                        </div>
                    </div>
                )}

                <button
                    onClick={handleCompact}
                    disabled={running}
                    className="w-full py-2.5 rounded-xl text-xs font-bold bg-white border border-amber-200 text-amber-600 hover:bg-amber-50 active:scale-95 transition-all disabled:opacity-50"
                >
                    {running ? '正在分层摘要…' : '手动压缩旧聊天记录'}
                </button>

                {report && report.results.length > 0 && (
                    <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3 space-y-1.5">
                        <div className="text-[10px] font-bold text-slate-500">压缩报告</div>
                        {report.results.map(r => (
                            <div key={r.charName} className="flex justify-between text-[10px] text-slate-500">
                                <span className="truncate">{r.charName}</span>
                                <span className={r.result.ok ? 'text-emerald-600' : 'text-rose-500'}>
                                    {r.result.ok ? `${r.result.compactedMessages} 条 → ${r.result.batches} 段纪要` : (r.result.skippedReason || '失败').slice(0, 30)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <p className="text-[10px] text-slate-400 leading-relaxed">
                    摘要调用走角色副 API（未配置则用主 API）。任一批次摘要失败即整体停止，绝不半删——保证不会因为压缩而丢记忆。卡片/语音/图片等功能消息不参与压缩。
                </p>
            </div>}
        </section>
    );
};

export default StorageGuardSettings;
