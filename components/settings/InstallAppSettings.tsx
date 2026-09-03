import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';

/**
 * 「安装到桌面 / 主屏幕」入口（PWA）。
 *
 * 装成 App 之后是独立窗口：手机上没有浏览器地址栏和那圈搜索框，电脑上像原生程序一样
 * 有自己的图标和任务栏项。数据完全不变——PWA 与浏览器标签共用同一个站点存储
 * （IndexedDB / localStorage），云端账号同步照常工作，装完不需要重新登录。
 *
 * 浏览器只在满足安装条件时才会给出 beforeinstallprompt：manifest + Service Worker
 * （含 fetch 处理、离线可返回外壳）+ https。条件不满足时这里不显示按钮，只给手动路径。
 */

const isStandalone = (): boolean => {
    try {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.matchMedia('(display-mode: window-controls-overlay)').matches
            || (navigator as unknown as { standalone?: boolean }).standalone === true;
    } catch {
        return false;
    }
};

const InstallAppSettings: React.FC = () => {
    const { addToast } = useOS();
    const [open, setOpen] = useState(false);
    const [installed, setInstalled] = useState(() => isStandalone());
    const [prompt, setPrompt] = useState<any>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const onPrompt = (e: Event) => {
            e.preventDefault();       // 拦下浏览器自带的小横幅，改由这里的按钮触发
            setPrompt(e);
        };
        const onInstalled = () => { setInstalled(true); setPrompt(null); };
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const handleInstall = async () => {
        if (!prompt) return;
        setBusy(true);
        try {
            trackEvent('安装为应用');
            await prompt.prompt();
            const choice = await prompt.userChoice;
            if (choice?.outcome === 'accepted') {
                setInstalled(true);
                addToast('已安装，之后从桌面图标打开即可', 'success');
            }
            setPrompt(null);
        } catch {
            addToast('安装未完成，可用浏览器菜单里的「安装应用」', 'info');
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <button type="button" onClick={() => setOpen(v => !v)} className={`flex items-center gap-2 w-full text-left ${open ? 'mb-4' : ''}`}>
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0-3-3m3 3 3-3m-8.25 6a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
                    </svg>
                </div>
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider flex-1 min-w-0">安装到桌面</h2>
                <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full ${installed ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-400'}`}>
                    {installed ? '已安装' : '未安装'}
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
            </button>

            {open && <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed">
                    装成独立应用后是自己的窗口：手机上没有浏览器地址栏那一条，电脑上有独立图标和任务栏项。数据与现在完全共用一份（聊天、角色、设置都在），云端账号同步照常，装完不用重新登录。
                </p>

                {installed ? (
                    <p className="text-[11px] text-violet-600 leading-relaxed px-3 py-2 rounded-xl bg-violet-50/70 border border-violet-100">
                        当前就是独立应用窗口，已经装好了。
                    </p>
                ) : prompt ? (
                    <button
                        onClick={handleInstall}
                        disabled={busy}
                        className="w-full py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white shadow-sm shadow-violet-200 active:scale-95 transition-all disabled:opacity-50"
                    >
                        {busy ? '正在安装…' : '安装到桌面 / 主屏幕'}
                    </button>
                ) : (
                    <div className="rounded-2xl bg-slate-50/70 border border-slate-100 p-3 space-y-1.5 text-[11px] text-slate-500 leading-relaxed">
                        <p className="font-bold text-slate-600">用浏览器菜单安装：</p>
                        <p>Edge / Chrome（电脑）：地址栏右侧的安装图标，或菜单 →「应用」→「安装此站点为应用」</p>
                        <p>安卓 Chrome / Edge：菜单 →「添加到主屏幕」/「安装应用」</p>
                        <p>iPhone Safari：分享 →「添加到主屏幕」</p>
                        <p className="text-slate-400">已经装过、或浏览器判断条件未满足时，这里不会出现一键按钮。</p>
                    </div>
                )}
            </div>}
        </section>
    );
};

export default InstallAppSettings;
