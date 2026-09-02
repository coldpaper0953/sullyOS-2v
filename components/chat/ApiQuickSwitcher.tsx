import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Lightning } from '@phosphor-icons/react';
import type { ApiPreset } from '../../types';

/**
 * 聊天页顶栏的 API 快捷切换：点开列出全部预设，点选即生效。
 *
 * 与设置页的「我的预设」并存——同一个 os_api_presets 数据源、同样的切换语义
 * （点名称直接生效），只是不用跳出聊天。当前生效的预设用 findActivePresetId
 * 按值比对识别，和设置页打勾逻辑同源，手改 URL/Key 后两边都不会说谎。
 */
interface ApiQuickSwitcherProps {
    presets: ApiPreset[];
    activePresetId: string | null;
    onSelect: (preset: ApiPreset) => void;
    /** 无预设时的指引提示（可选，缺省静默）。 */
    addToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
}

const ApiQuickSwitcher: React.FC<ApiQuickSwitcherProps> = ({ presets, activePresetId, onSelect, addToast }) => {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDocPointerDown = (e: PointerEvent) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            if (anchorRef.current?.contains(e.target as Node)) return;
            setOpen(false);
        };
        document.addEventListener('pointerdown', onDocPointerDown);
        return () => document.removeEventListener('pointerdown', onDocPointerDown);
    }, [open]);

    if (presets.length === 0) {
        // 没建预设时按钮不能整个消失——用户会找不到这个功能在哪。
        // 显示为禁用态闪电，点了给出去设置建预设的指引。
        return (
            <button
                onClick={() => addToast?.('还没有 API 预设。到 设置 → API 配置 → 我的预设 添加后，这里就能一键切换', 'info')}
                title="快捷切换 API（还没有预设）"
                aria-label="快捷切换 API"
                className="relative p-2 text-slate-300"
            >
                <Lightning className="w-5 h-5" weight="fill" />
            </button>
        );
    }
    const activePreset = presets.find(p => p.id === activePresetId) || null;

    return (
        <>
            <button
                ref={anchorRef}
                onClick={() => setOpen(v => !v)}
                title={`API：${activePreset ? activePreset.name : '手填配置'} · 点击切换`}
                aria-label="快捷切换 API"
                className={`relative p-2 transition-colors ${open ? 'text-primary' : 'text-slate-400 hover:text-primary'}`}
            >
                <Lightning className="w-5 h-5" weight="fill" />
                {activePreset && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary border border-white" />
                )}
            </button>
            {open && createPortal(
                <div
                    ref={menuRef}
                    style={{
                        position: 'fixed',
                        left: Math.max(8, Math.min((anchorRef.current?.getBoundingClientRect().left ?? 0) - 140, window.innerWidth - 192)),
                        top: (anchorRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
                    }}
                    className="z-[9998] w-48 bg-white rounded-xl shadow-lg border border-slate-200 p-1.5"
                >
                    <div className="px-2 py-1 text-[9px] font-bold text-slate-400 uppercase tracking-widest">快捷切换 API</div>
                    {presets.map(preset => (
                        <button
                            key={preset.id}
                            onClick={() => { onSelect(preset); setOpen(false); }}
                            className={`w-full text-left px-2.5 py-2 rounded-lg text-xs font-medium truncate transition-colors ${
                                preset.id === activePresetId
                                    ? 'bg-primary/10 text-primary font-bold'
                                    : 'text-slate-600 hover:bg-slate-50'
                            }`}
                        >
                            {preset.name}
                            {preset.id === activePresetId && <span className="ml-1 text-[9px]">· 使用中</span>}
                        </button>
                    ))}
                    <div className="px-2 pt-1 pb-0.5 text-[9px] text-slate-300 border-t border-slate-100 mt-1">
                        与设置 → API 配置的预设同源
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
};

export default ApiQuickSwitcher;
