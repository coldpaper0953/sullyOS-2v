import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import type { CharacterProfile, Message, AppID as AppIDType } from '../types';
import TokenImg from '../components/os/TokenImg';
import { trackEvent } from '../utils/analytics';

/**
 * 通讯录 App —— 所有可对话角色的一览表。
 *
 * 和「神经链接」（角色档案管理）不同：这里只回答一个问题——
 * 「我现在想找 ta 说话」，点头像即切换到和该角色的聊天。
 * 每行显示：头像 / 名字 / 最后一条消息预览 / 未读徽标，
 * 排序按最近聊过优先（没聊过的角色按创建时间靠后）。
 */

interface LastMsgInfo {
    preview: string;
    timestamp: number;
}

const previewOf = (msg: Message): string => {
    if (msg.type === 'image') return '[图片]';
    if (msg.type === 'emoji') return '[表情]';
    return (msg.content || '').replace(/\s+/g, ' ').slice(0, 40);
};

const timeLabel = (ts: number): string => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
};

const ContactsApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, setActiveCharacterId, openApp, unreadMessages, characterGroups } = useOS();
    const [lastMsgs, setLastMsgs] = useState<Record<string, LastMsgInfo>>({});
    const [search, setSearch] = useState('');

    // 只拉每个角色最后 1 条消息做预览。角色数量有限（十几个量级），逐个取轻量查询即可；
    // 消息列表页自己有完整分页，这里绝不整段拉取。
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const entries: Record<string, LastMsgInfo> = {};
            await Promise.all(characters.map(async (c) => {
                try {
                    const messages = await DB.getRecentMessagesByCharId(c.id, 1);
                    const last = messages[0];
                    if (last) entries[c.id] = { preview: previewOf(last), timestamp: last.timestamp };
                } catch { /* 单个角色失败不拖累整页 */ }
            }));
            if (!cancelled) setLastMsgs(entries);
        })();
        return () => { cancelled = true; };
    }, [characters]);

    // 最近聊过优先，其次是新角色在前；有搜索词时按名字过滤
    const sorted = useMemo(() => {
        const filtered = characters.filter(c =>
            !search.trim() || (c.name || '').toLowerCase().includes(search.trim().toLowerCase())
        );
        return [...filtered].sort((a, b) => {
            const ta = lastMsgs[a.id]?.timestamp ?? 0;
            const tb = lastMsgs[b.id]?.timestamp ?? 0;
            if (ta !== tb) return tb - ta;
            // 都没聊过：新加入的排前面。角色没有 createdAt 字段，但 id 是 char-${Date.now()}，
            // 从 id 提取时间戳当次级排序键（解析失败按 0 兜底，顺序退化为原数组序）。
            const num = (id: string) => Number(id.match(/^char-(\d+)/)?.[1]) || 0;
            return num(b.id) - num(a.id);
        });
    }, [characters, lastMsgs, search]);

const CHAT_APP: AppIDType = 'chat' as AppIDType;

const openChat = (setActiveCharacterId: (id: string) => void, openApp: (id: AppIDType) => void, charId: string) => {
    trackEvent('通讯录切换聊天');
    setActiveCharacterId(charId);
    openApp(CHAT_APP);
};

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col font-light">
            {/* 顶栏：与群聊列表同一视觉语言 */}
            <div className="shrink-0 z-10 sticky top-0">
                <div className="bg-transparent backdrop-blur-xl" style={{ height: 'var(--safe-top)' }} />
                <div className="bg-white/70 backdrop-blur-md flex items-end pb-3 px-4 border-b border-white/40 h-20">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-medium text-slate-700 text-lg tracking-wide pl-2">通讯录</span>
                    <div className="flex-1"></div>
                    <span className="text-[10px] text-slate-400 pb-1">{characters.length} 位联系人</span>
                </div>
            </div>

            {/* 搜索框 */}
            <div className="px-4 pt-3 pb-1 shrink-0">
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="搜索名字…"
                    className="w-full px-4 py-2.5 bg-white/80 border border-slate-200/60 rounded-2xl text-sm text-slate-700 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-violet-500/15 transition-all shadow-sm"
                />
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                {sorted.map(c => {
                    const last = lastMsgs[c.id];
                    const unread = unreadMessages[c.id] || 0;
                    const isActive = c.id === activeCharacterId;
                    return (
                        <div
                            key={c.id}
                            onClick={() => openChat(setActiveCharacterId, openApp, c.id)}
                            className={`bg-white p-4 rounded-2xl shadow-sm border flex items-center gap-4 active:scale-[0.98] transition-all cursor-pointer group hover:bg-violet-50/30 ${isActive ? 'border-violet-300' : 'border-slate-100'}`}
                        >
                            <div className="relative shrink-0">
                                <TokenImg value={c.avatar} className="w-14 h-14 rounded-2xl object-cover border border-slate-200 shadow-sm" />
                                {unread > 0 && (
                                    <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center shadow-md shadow-rose-200">
                                        {unread > 99 ? '99+' : unread}
                                    </span>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-bold text-slate-700 truncate text-base">{c.name}</span>
                                    {isActive && <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-500 border border-violet-200 font-semibold">当前</span>}
                                </div>
                                <div className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
                                    <span className="truncate">{last ? last.preview : '开始第一段对话吧'}</span>
                                    {last && <span className="shrink-0 text-slate-300">·</span>}
                                    {last && <span className="shrink-0 text-slate-400/80">{timeLabel(last.timestamp)}</span>}
                                </div>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-300 group-hover:text-violet-300 transition-colors shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                        </div>
                    );
                })}
                {sorted.length === 0 && (
                    <div className="text-center text-slate-400 text-xs py-10">
                        {characters.length === 0 ? '还没有可以聊天的角色。去「神经链接」新建一个吧。' : '没有匹配的联系人'}
                    </div>
                )}
                {characterGroups.length > 0 && (
                    <p className="text-[10px] text-slate-400/80 text-center pt-1">分组管理请前往「神经链接」</p>
                )}
            </div>
        </div>
    );
};

export default ContactsApp;
