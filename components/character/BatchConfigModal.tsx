import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckSquare, Square, Lightning, Clock, ArrowsClockwise, BookOpenText, CaretDown, CaretRight } from '@phosphor-icons/react';
import type { CharacterProfile, ApiPreset, Worldbook } from '../../types';
import { configFromPreset } from '../../utils/apiPresetSwitch';
import { toMountedWorldbook } from '../../utils/worldbook';
import TokenImg from '../os/TokenImg';

/**
 * 角色批量配置（神经链接列表顶栏「批量」入口）
 *
 * 用户痛点：13 个角色要逐个点开设置才能改同一项配置。
 * 交互参照世界书挂载弹窗：勾选若干角色 → 选一项配置 → 填统一值 → 一次下发到全部勾选角色。
 *
 * 支持的配置项（per-character 字段，逐个 updateCharacter 覆盖；共享字段统一、
 * 角色个性化字段如 enabled 不在批量范围，避免一键误伤）：
 *   - 主动消息 1.0：开关 + 频率 + 副 API（proactiveConfig）
 *   - 主动消息 2.0：副 API（activeMsg2Config.secondaryApi）
 *   - 情绪评估副 API（emotionConfig.api，同 Chat 面板的「同步到全部角色」语义）
 */

interface BatchConfigModalProps {
    characters: CharacterProfile[];
    apiPresets: ApiPreset[];
    worldbooks: Worldbook[];
    onClose: () => void;
    onApply: (charIds: string[], updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

type ConfigKey = 'proactive' | 'proactive2Secondary' | 'emotionApi' | 'worldbooks';

const CONFIG_META: Record<ConfigKey, { label: string; desc: string }> = {
    proactive: { label: '主动消息（本地）', desc: '开关 + 频率 + 副 API，覆盖 proactiveConfig' },
    proactive2Secondary: { label: '主动消息 2.0 副 API', desc: '云端任务的专用 API（activeMsg2Config）' },
    emotionApi: { label: '情绪评估副 API', desc: '情绪评估专用三件套（emotionConfig.api）' },
    worldbooks: { label: '世界书挂载', desc: '统一挂载 / 替换勾选角色的世界书（mountedWorldbooks）' },
};

const INTERVAL_OPTIONS = [30, 60, 120, 240, 480];

const BatchConfigModal: React.FC<BatchConfigModalProps> = ({ characters, apiPresets, worldbooks, onClose, onApply, addToast }) => {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [configKey, setConfigKey] = useState<ConfigKey>('proactive');
    // 主动消息 1.0
    const [proactiveEnabled, setProactiveEnabled] = useState(true);
    const [proactiveInterval, setProactiveInterval] = useState(120);
    const [proactiveUseSecondary, setProactiveUseSecondary] = useState(false);
    // 副 API（1.0 / 2.0 / 情绪 共用一套填写区，值统一从预设点选）
    const [secondaryApi, setSecondaryApi] = useState({ baseUrl: '', apiKey: '', model: '' });
    // 世界书挂载
    const [wbSelectedIds, setWbSelectedIds] = useState<Set<string>>(new Set());
    const [wbMode, setWbMode] = useState<'append' | 'replace'>('append');
    // 分组挂载：默认按分组展示，可展开组内勾选单本（挂载一整组 / 单条目并存）
    const [wbGroupView, setWbGroupView] = useState<'grouped' | 'flat'>('grouped');
    const [wbExpandedGroups, setWbExpandedGroups] = useState<Set<string>>(new Set());

    // 世界书按 category 分组（与角色挂载弹窗同语义：空 category 归「未分类设定 (General)」）
    const wbGroups = useMemo(() => {
        const groups: Array<{ category: string; books: typeof worldbooks }> = [];
        const index = new Map<string, number>();
        worldbooks.forEach(b => {
            const cat = (b.category || '').trim() || '未分类设定 (General)';
            if (!index.has(cat)) {
                index.set(cat, groups.length);
                groups.push({ category: cat, books: [] });
            }
            groups[index.get(cat)!].books.push(b);
        });
        return groups;
    }, [worldbooks]);

    const toggleWb = (id: string) => {
        setWbSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleWbGroup = (category: string) => {
        const books = wbGroups.find(g => g.category === category)?.books || [];
        const allHeld = books.every(b => wbSelectedIds.has(b.id));
        setWbSelectedIds(prev => {
            const next = new Set(prev);
            books.forEach(b => { if (allHeld) next.delete(b.id); else next.add(b.id); });
            return next;
        });
    };

    const toggleWbGroupExpand = (category: string) => {
        setWbExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(category)) next.delete(category);
            else next.add(category);
            return next;
        });
    };

    const toggleChar = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const applyToPreset = (preset: ApiPreset) => {
        setSecondaryApi({
            baseUrl: preset.config.baseUrl,
            apiKey: preset.config.apiKey,
            model: preset.config.model,
        });
    };

    // 当前配置项是否需要副 API 填写区
    const needsSecondaryApi = configKey !== 'proactive' && configKey !== 'worldbooks' ? true : (configKey === 'proactive' && proactiveUseSecondary);

    const handleApply = () => {
        if (selectedIds.size === 0) {
            addToast('请先勾选至少一个角色', 'error');
            return;
        }
        if (configKey === 'worldbooks') {
            if (wbSelectedIds.size === 0) {
                addToast('请先勾选要挂载的世界书', 'error');
                return;
            }
            const books = worldbooks.filter(b => wbSelectedIds.has(b.id));
            // 挂载即快照：把世界书当前内容拷贝到每个角色（和单个角色挂载弹窗同语义）。
            // append 去重保序；replace 直接替换，角色原有的挂载清空。
            onApply([...selectedIds], (prev) => {
                if (wbMode === 'replace') {
                    return { mountedWorldbooks: books.map(toMountedWorldbook) };
                }
                const current = prev.mountedWorldbooks || [];
                const held = new Set(current.map(b => b.id));
                const additions = books.filter(b => !held.has(b.id)).map(toMountedWorldbook);
                return { mountedWorldbooks: [...current, ...additions] };
            });
            const appended = wbMode === 'append'
                ? books.filter(b => !(characters.find(c => selectedIds.has(c.id))?.mountedWorldbooks || []).some(m => m.id === b.id)).length
                : books.length;
            addToast(`已${wbMode === 'replace' ? '替换' : '挂载'} ${appended} 本世界书到 ${selectedIds.size} 个角色`, 'success');
            onClose();
            return;
        }
        const apiFilled = secondaryApi.baseUrl.trim() && secondaryApi.apiKey.trim() && secondaryApi.model.trim();
        if (needsSecondaryApi && !apiFilled) {
            addToast('副 API 三项（URL / Key / Model）都需要填写', 'error');
            return;
        }
        const ids = [...selectedIds];
        let summary = '';
        if (configKey === 'proactive') {
            onApply(ids, () => ({
                proactiveConfig: {
                    enabled: proactiveEnabled,
                    intervalMinutes: proactiveInterval,
                    ...(proactiveUseSecondary ? { useSecondaryApi: true, secondaryApi: { ...secondaryApi } } : {}),
                },
            }));
            summary = `主动消息（${proactiveEnabled ? '开 · ' + proactiveInterval + ' 分钟' : '关'}${proactiveUseSecondary ? ' · 副API' : ''}）`;
        } else if (configKey === 'proactive2Secondary') {
            onApply(ids, prev => ({
                activeMsg2Config: {
                    ...prev.activeMsg2Config,
                    enabled: prev.activeMsg2Config?.enabled ?? true,
                    useSecondaryApi: true,
                    secondaryApi: { ...secondaryApi },
                },
            }));
            summary = '主动消息 2.0 副 API';
        } else {
            onApply(ids, prev => ({
                emotionConfig: {
                    ...prev.emotionConfig,
                    enabled: prev.emotionConfig?.enabled ?? false,
                    api: { ...secondaryApi },
                },
            }));
            summary = '情绪评估副 API';
        }
        addToast(`已应用到 ${ids.length} 个角色：${summary}`, 'success');
        onClose();
    };

    const allSelected = selectedIds.size === characters.length && characters.length > 0;

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center bg-slate-900/45 backdrop-blur-[1px]" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="w-full sm:max-w-lg max-h-[86vh] rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl border border-slate-100 flex flex-col overflow-hidden animate-fade-in"
            >
                {/* 标题栏 */}
                <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-50">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">批量配置</h3>
                        <p className="text-[10px] text-slate-400 mt-0.5">勾选角色 → 选配置项 → 统一下发</p>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-full text-slate-300 hover:bg-slate-100 hover:text-slate-500 transition-colors">
                        <X className="w-4 h-4" weight="bold" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {/* ① 角色勾选区 */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                选择角色（已选 {selectedIds.size}/{characters.length}）
                            </span>
                            <button
                                onClick={() => setSelectedIds(allSelected ? new Set() : new Set(characters.map(c => c.id)))}
                                className="text-[10px] font-bold text-violet-500 hover:text-violet-600 active:scale-95 transition-transform"
                            >
                                {allSelected ? '全不选' : '全选'}
                            </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            {characters.map(char => {
                                const checked = selectedIds.has(char.id);
                                return (
                                    <button
                                        key={char.id}
                                        onClick={() => toggleChar(char.id)}
                                        className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all text-left ${
                                            checked
                                                ? 'bg-violet-50/80 border-violet-300 shadow-sm'
                                                : 'bg-white border-slate-100 hover:border-violet-200'
                                        }`}
                                    >
                                        {checked
                                            ? <CheckSquare className="w-4 h-4 text-violet-500 shrink-0" weight="fill" />
                                            : <Square className="w-4 h-4 text-slate-300 shrink-0" />}
                                        <TokenImg value={char.avatar} className="w-7 h-7 rounded-full object-cover shrink-0" />
                                        <span className={`text-xs font-bold truncate ${checked ? 'text-violet-600' : 'text-slate-600'}`}>{char.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* ② 配置项选择 */}
                    <div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">配置项</span>
                        <div className="space-y-1.5">
                            {(Object.keys(CONFIG_META) as ConfigKey[]).map(key => (
                                <button
                                    key={key}
                                    onClick={() => setConfigKey(key)}
                                    className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                                        configKey === key
                                            ? 'bg-indigo-50/80 border-indigo-300 shadow-sm'
                                            : 'bg-white border-slate-100 hover:border-indigo-200'
                                    }`}
                                >
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                                        key === 'proactive' ? 'bg-amber-100 text-amber-600' : key === 'proactive2Secondary' ? 'bg-sky-100 text-sky-600' : key === 'emotionApi' ? 'bg-pink-100 text-pink-600' : 'bg-indigo-100 text-indigo-600'
                                    }`}>
                                        {key === 'proactive' ? <Lightning className="w-4 h-4" weight="fill" /> : key === 'proactive2Secondary' ? <ArrowsClockwise className="w-4 h-4" /> : key === 'emotionApi' ? <Clock className="w-4 h-4" /> : <BookOpenText className="w-4 h-4" />}
                                    </div>
                                    <div className="min-w-0">
                                        <div className={`text-xs font-bold ${configKey === key ? 'text-indigo-600' : 'text-slate-600'}`}>{CONFIG_META[key].label}</div>
                                        <div className="text-[9px] text-slate-400 mt-0.5 truncate">{CONFIG_META[key].desc}</div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ③ 统一值设置 */}
                    <div className="rounded-2xl bg-slate-50/70 border border-slate-100 p-3.5 space-y-3">
                        {configKey === 'worldbooks' && (
                            <>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-slate-600 font-bold">挂载方式</span>
                                    <div className="flex gap-1.5">
                                        <button
                                            onClick={() => setWbMode('append')}
                                            className={`px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors ${wbMode === 'append' ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'}`}
                                        >
                                            追加挂载
                                        </button>
                                        <button
                                            onClick={() => setWbMode('replace')}
                                            className={`px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors ${wbMode === 'replace' ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'}`}
                                        >
                                            替换全部
                                        </button>
                                    </div>
                                </div>
                                {wbMode === 'replace' && (
                                    <p className="text-[10px] text-amber-500 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">替换会清掉勾选角色身上原有的全部世界书，再挂上这里选的。</p>
                                )}
                                <div>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[10px] text-slate-400">
                                            选择世界书（已选 {wbSelectedIds.size}/{worldbooks.length}）
                                            {wbGroupView === 'grouped' && wbGroups.length > 1 && ' · 点分组头挂载整组，展开可勾单本'}
                                        </span>
                                        <div className="flex items-center gap-2.5">
                                            {worldbooks.length > 0 && (
                                                <>
                                                    <button
                                                        onClick={() => setWbGroupView(wbGroupView === 'grouped' ? 'flat' : 'grouped')}
                                                        className="text-[10px] font-bold text-slate-400 hover:text-violet-500 active:scale-95 transition-transform"
                                                    >
                                                        {wbGroupView === 'grouped' ? '平铺列表' : '按分组'}
                                                    </button>
                                                    <button
                                                        onClick={() => setWbSelectedIds(wbSelectedIds.size === worldbooks.length ? new Set() : new Set(worldbooks.map(b => b.id)))}
                                                        className="text-[10px] font-bold text-violet-500 hover:text-violet-600 active:scale-95 transition-transform"
                                                    >
                                                        {wbSelectedIds.size === worldbooks.length ? '全不选' : '全选'}
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    {worldbooks.length === 0 ? (
                                        <p className="text-[10px] text-slate-400 text-center py-3">还没有世界书。去「世界书」App 先建一本。</p>
                                    ) : wbGroupView === 'grouped' ? (
                                        <div className="max-h-56 overflow-y-auto pr-1 space-y-1.5">
                                            {wbGroups.map(group => {
                                                const allHeld = group.books.every(b => wbSelectedIds.has(b.id));
                                                const someHeld = group.books.some(b => wbSelectedIds.has(b.id));
                                                const isExpanded = wbExpandedGroups.has(group.category);
                                                return (
                                                    <div key={group.category} className="rounded-xl border border-slate-100 bg-white overflow-hidden">
                                                        <div className="flex items-center">
                                                            <button
                                                                onClick={() => toggleWbGroupExpand(group.category)}
                                                                className="flex items-center gap-1.5 pl-2.5 pr-1 py-2 text-slate-400 hover:text-slate-600 active:scale-95 transition-transform"
                                                            >
                                                                {isExpanded
                                                                    ? <CaretDown className="w-3 h-3" weight="fill" />
                                                                    : <CaretRight className="w-3 h-3" weight="fill" />}
                                                            </button>
                                                            <button
                                                                onClick={() => toggleWbGroup(group.category)}
                                                                className="flex items-center gap-2 flex-1 min-w-0 py-2 pr-2.5 text-left active:scale-[0.99] transition-transform"
                                                            >
                                                                {allHeld
                                                                    ? <CheckSquare className="w-4 h-4 text-violet-500 shrink-0" weight="fill" />
                                                                    : <Square className={`w-4 h-4 shrink-0 ${someHeld ? 'text-violet-300' : 'text-slate-300'}`} />}
                                                                <span className={`text-xs font-bold truncate ${allHeld ? 'text-violet-600' : 'text-slate-600'}`}>{group.category}</span>
                                                                <span className="text-[9px] text-slate-400 shrink-0">{allHeld ? `${group.books.length} 本已选` : `${group.books.length} 本`}</span>
                                                            </button>
                                                        </div>
                                                        {isExpanded && (
                                                            <div className="grid grid-cols-2 gap-1.5 px-2 pb-2">
                                                                {group.books.map(book => {
                                                                    const checked = wbSelectedIds.has(book.id);
                                                                    return (
                                                                        <button
                                                                            key={book.id}
                                                                            onClick={() => toggleWb(book.id)}
                                                                            className={`flex items-center gap-2 p-2 rounded-lg border transition-all text-left ${
                                                                                checked
                                                                                    ? 'bg-violet-50/80 border-violet-300'
                                                                                    : 'bg-slate-50/50 border-slate-100 hover:border-violet-200'
                                                                            }`}
                                                                        >
                                                                            {checked
                                                                                ? <CheckSquare className="w-3.5 h-3.5 text-violet-500 shrink-0" weight="fill" />
                                                                                : <Square className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
                                                                            <div className="text-xs font-bold truncate text-slate-600">{book.title}</div>
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                                            {worldbooks.map(book => {
                                                const checked = wbSelectedIds.has(book.id);
                                                return (
                                                    <button
                                                        key={book.id}
                                                        onClick={() => toggleWb(book.id)}
                                                        className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all text-left ${
                                                            checked
                                                                ? 'bg-violet-50/80 border-violet-300 shadow-sm'
                                                                : 'bg-white border-slate-100 hover:border-violet-200'
                                                        }`}
                                                    >
                                                        {checked
                                                            ? <CheckSquare className="w-4 h-4 text-violet-500 shrink-0" weight="fill" />
                                                            : <Square className="w-4 h-4 text-slate-300 shrink-0" />}
                                                        <div className="min-w-0">
                                                            <div className={`text-xs font-bold truncate ${checked ? 'text-violet-600' : 'text-slate-600'}`}>{book.title}</div>
                                                            <div className="text-[9px] text-slate-400 truncate">{book.category || '未分类'}</div>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                        {configKey === 'proactive' && (
                            <>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-slate-600 font-bold">启用主动消息</span>
                                    <button
                                        onClick={() => setProactiveEnabled(v => !v)}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${proactiveEnabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${proactiveEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                    </button>
                                </div>
                                {proactiveEnabled && (
                                    <>
                                        <div>
                                            <span className="text-[10px] text-slate-400">发送频率</span>
                                            <div className="flex gap-1.5 mt-1 flex-wrap">
                                                {INTERVAL_OPTIONS.map(min => (
                                                    <button
                                                        key={min}
                                                        onClick={() => setProactiveInterval(min)}
                                                        className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors ${
                                                            proactiveInterval === min ? 'bg-violet-500 text-white border-violet-500' : 'bg-white text-slate-500 border-slate-200'
                                                        }`}
                                                    >
                                                        {min >= 60 ? `${min / 60} 小时` : `${min} 分钟`}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between pt-1">
                                            <span className="text-[10px] text-slate-400">使用副 API 发送</span>
                                            <button
                                                onClick={() => setProactiveUseSecondary(v => !v)}
                                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${proactiveUseSecondary ? 'bg-violet-500' : 'bg-slate-200'}`}
                                            >
                                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${proactiveUseSecondary ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                            </button>
                                        </div>
                                    </>
                                )}
                            </>
                        )}

                        {needsSecondaryApi && (
                            <div className="space-y-2.5 pt-1">
                                {apiPresets.length > 0 && (
                                    <div>
                                        <span className="text-[10px] text-slate-400">从预设点选</span>
                                        <div className="flex gap-1.5 mt-1 flex-wrap">
                                            {apiPresets.map(preset => (
                                                <button
                                                    key={preset.id}
                                                    onClick={() => applyToPreset(preset)}
                                                    className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-white border border-slate-200 text-slate-500 hover:border-violet-300 hover:text-violet-500 transition-colors"
                                                >
                                                    {preset.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="grid grid-cols-1 gap-2">
                                    <input value={secondaryApi.baseUrl} onChange={e => setSecondaryApi({ ...secondaryApi, baseUrl: e.target.value })} placeholder="副 API URL" className="w-full bg-white border border-slate-200/60 rounded-xl px-3 py-2 text-[11px] font-mono focus:bg-white outline-none" />
                                    <input value={secondaryApi.apiKey} onChange={e => setSecondaryApi({ ...secondaryApi, apiKey: e.target.value })} placeholder="API Key" type="password" className="w-full bg-white border border-slate-200/60 rounded-xl px-3 py-2 text-[11px] font-mono focus:bg-white outline-none" />
                                    <input value={secondaryApi.model} onChange={e => setSecondaryApi({ ...secondaryApi, model: e.target.value })} placeholder="Model" className="w-full bg-white border border-slate-200/60 rounded-xl px-3 py-2 text-[11px] font-mono focus:bg-white outline-none" />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* 底部操作 */}
                <div className="px-5 py-4 border-t border-slate-50 flex gap-3">
                    <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-xs font-bold text-slate-500 bg-slate-100 active:scale-95 transition-transform">取消</button>
                    <button
                        onClick={handleApply}
                        disabled={selectedIds.size === 0}
                        className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${selectedIds.size === 0 ? 'bg-violet-200 text-white' : 'bg-violet-500 text-white shadow-lg shadow-violet-200 active:scale-95'}`}
                    >
                        {configKey === 'worldbooks'
                            ? `挂载到 ${selectedIds.size} 个角色`
                            : `应用到 ${selectedIds.size} 个角色`}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default BatchConfigModal;
