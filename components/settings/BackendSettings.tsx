import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import {
    addBackendModelProfile,
    createBackendPairingCode,
    deleteBackendModelProfile,
    disableBackendPush,
    discoverBackendModels,
    enableBackendPush,
    exchangeBackendPairingCode,
    getBackendAgents,
    getBackendModelPool,
    getBackendPushConfig,
    loadBackendChatConfig,
    saveBackendChatConfig,
    syncBackendCharacterFully,
    syncBackendMemoryPalaceFully,
    testBackendConnection,
    testBackendPush,
    updateBackendAgentAutonomy,
    updateBackendModelRouting,
    type BackendAgentAutonomy,
    type BackendAgentsResult,
    type BackendChatConfig,
    type BackendModelPool,
    type BackendPushConfig,
} from '../../utils/backendClient';
import { acknowledgeBackendMemoryChangesThrough } from '../../utils/backendSyncQueue';
import { DB } from '../../utils/db';
import {
    AnticipationDB,
    DigestReportDB,
    EventBoxDB,
    MemoryBatchDB,
    MemoryLinkDB,
    MemoryNodeDB,
    MemoryVectorDB,
    RoomPlateDB,
    TopicBoxDB,
} from '../../utils/memoryPalace/db';
import BackendToolSettings from './BackendToolSettings';
import { resolveCharTimeZone } from '../../utils/timezone';

const statusToneClass = (text: string) => {
    if (text.startsWith('✅')) return 'bg-emerald-50 text-emerald-700';
    if (text.startsWith('⚠️')) return 'bg-amber-50 text-amber-700';
    if (text.startsWith('❌')) return 'bg-rose-50 text-rose-600';
    return 'bg-sky-50 text-sky-700';
};

const newSnapshotId = () => typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const BackendSettings: React.FC = () => {
    const { characters, userProfile, addToast } = useOS();
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState<BackendChatConfig>(loadBackendChatConfig);
    const [pairingCode, setPairingCode] = useState('');
    const [generatedPairingCode, setGeneratedPairingCode] = useState('');
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [agents, setAgents] = useState<BackendAgentsResult | null>(null);
    const [agentBusyId, setAgentBusyId] = useState<string | null>(null);
    const [modelPool, setModelPool] = useState<BackendModelPool | null>(null);
    const [pushConfig, setPushConfig] = useState<BackendPushConfig | null>(null);
    const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
    const [newModel, setNewModel] = useState({ label: '', baseUrl: '', apiKey: '', model: '' });

    const persistConfig = () => {
        const saved = saveBackendChatConfig({ ...config, enabled: true, serverContextEnabled: false });
        setConfig(saved);
        return saved;
    };

    const refreshRemoteState = async (candidate: BackendChatConfig) => {
        const [nextAgents, nextPool, nextPush] = await Promise.all([
            getBackendAgents(candidate),
            getBackendModelPool(candidate),
            getBackendPushConfig(candidate),
        ]);
        setAgents(nextAgents);
        setModelPool(nextPool);
        setPushConfig(nextPush);
    };

    useEffect(() => {
        if (!open || !config.token.trim()) return;
        void refreshRemoteState(config).catch(() => undefined);
    }, [open]);

    const connect = async () => {
        setBusy('connect');
        try {
            const candidate = persistConfig();
            const result = await testBackendConnection(candidate);
            if (!result.ok) throw new Error(result.message || '连接失败');
            setStatus(`✅ 后端已连接${result.modelConfigured ? `，当前模型 ${result.model || '已配置'}` : '，模型池尚未配置'}`);
            await refreshRemoteState(candidate);
        } catch (error) {
            setStatus(`❌ 连接失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const pair = async () => {
        if (!pairingCode.trim()) return;
        setBusy('pair');
        try {
            const paired = await exchangeBackendPairingCode(config.baseUrl, pairingCode);
            setConfig(paired);
            setPairingCode('');
            setStatus('✅ 手机已与后端配对');
            await refreshRemoteState(paired);
        } catch (error) {
            setStatus(`❌ 配对失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const addModel = async () => {
        if (!newModel.baseUrl.trim() || !newModel.apiKey.trim() || !newModel.model.trim()) return;
        setBusy('model');
        try {
            const candidate = persistConfig();
            await addBackendModelProfile(candidate, {
                label: newModel.label.trim() || newModel.model.trim(),
                baseUrl: newModel.baseUrl,
                apiKey: newModel.apiKey,
                model: newModel.model,
            });
            setNewModel({ label: '', baseUrl: '', apiKey: '', model: '' });
            setModelPool(await getBackendModelPool(candidate));
            setStatus('✅ 已加入后端模型池');
        } catch (error) {
            setStatus(`❌ 保存模型失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const discoverModels = async () => {
        if (!newModel.baseUrl.trim() || !newModel.apiKey.trim()) return;
        setBusy('discover-models');
        try {
            const models = await discoverBackendModels(persistConfig(), {
                baseUrl: newModel.baseUrl,
                apiKey: newModel.apiKey,
            });
            setDiscoveredModels(models);
            if (!newModel.model && models[0]) setNewModel(current => ({ ...current, model: models[0] }));
            setStatus(models.length ? `✅ 已发现 ${models.length} 个可用模型` : '⚠️ 接口没有返回可用模型');
        } catch (error) {
            setStatus(`❌ 读取模型失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const generatePairingCode = async () => {
        setBusy('generate-pair');
        try {
            const result = await createBackendPairingCode(persistConfig());
            setGeneratedPairingCode(result.code);
            setStatus('✅ 新配对码已生成，15 分钟内使用一次即失效');
        } catch (error) {
            setStatus(`❌ 生成配对码失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const syncAll = async () => {
        setBusy('sync');
        setStatus('正在读取这台手机中的完整数据…');
        try {
            const candidate = persistConfig();
            const storedCharacters = await DB.getAllCharacters();
            const allLinks = await MemoryLinkDB.getAll();
            const totals = { messages: 0, memories: 0, links: 0, vectors: 0 };
            const mismatches: string[] = [];

            for (let index = 0; index < storedCharacters.length; index += 1) {
                const character = storedCharacters[index];
                const snapshotStartedAt = Date.now();
                setStatus(`正在同步 ${index + 1}/${storedCharacters.length}：${character.name}`);
                const [messages, memories, vectors, eventBoxes, roomPlates, digestReports, anticipations, batches, topicBoxes] = await Promise.all([
                    DB.getMessagesByCharId(character.id, true),
                    MemoryNodeDB.getByCharId(character.id),
                    MemoryVectorDB.getAllByCharId(character.id),
                    EventBoxDB.getByCharId(character.id),
                    RoomPlateDB.getByCharId(character.id),
                    DigestReportDB.getByCharId(character.id),
                    AnticipationDB.getByCharId(character.id),
                    MemoryBatchDB.getByCharId(character.id),
                    TopicBoxDB.getByCharId(character.id),
                ]);
                const nodeIds = new Set(memories.map(memory => memory.id));
                const links = allLinks.filter(link => nodeIds.has(link.sourceId) && nodeIds.has(link.targetId));
                const snapshotId = newSnapshotId();
                const contextResult = await syncBackendCharacterFully({
                    config: candidate,
                    character,
                    user: userProfile,
                    messages,
                    memories,
                    snapshotId,
                    onProgress: (done, total) => setStatus(`正在同步 ${character.name}：聊天与节点 ${done}/${total}`),
                });
                const palaceResult = await syncBackendMemoryPalaceFully({
                    config: candidate,
                    characterId: character.id,
                    eventBoxes,
                    roomPlates,
                    links,
                    anticipations,
                    digestReports,
                    vectors,
                    batches,
                    topicBoxes,
                    snapshotId,
                    onProgress: (done, total) => setStatus(`正在同步 ${character.name}：记忆宫殿 ${done}/${total}`),
                });
                await acknowledgeBackendMemoryChangesThrough(character.id, snapshotStartedAt);
                const expected: Record<string, number> = {
                    nodes: memories.length,
                    event_boxes: eventBoxes.length,
                    room_plates: roomPlates.length,
                    links: links.length,
                    anticipations: anticipations.length,
                    digest_reports: digestReports.length,
                    vectors: vectors.length,
                    batches: batches.length,
                    topic_boxes: topicBoxes.length,
                };
                for (const [key, count] of Object.entries(expected)) {
                    if (palaceResult.backendCounts[key] !== count) {
                        mismatches.push(`${character.name}.${key}：手机 ${count} / 后端 ${palaceResult.backendCounts[key] ?? '未知'}`);
                    }
                }
                totals.messages += contextResult.messages;
                totals.memories += contextResult.memories;
                totals.links += palaceResult.links;
                totals.vectors += palaceResult.vectors;
            }

            setStatus(mismatches.length
                ? `⚠️ 同步完成，但数量核对仍有差异：${mismatches.slice(0, 3).join('；')}`
                : `✅ 完整同步并核对通过：${storedCharacters.length} 个角色、${totals.messages} 条聊天、${totals.memories} 个节点、${totals.links} 条关联、${totals.vectors} 条向量。`);
            await refreshRemoteState(candidate);
        } catch (error) {
            setStatus(`❌ 完整同步失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const saveAgentAutonomy = async (
        agent: BackendAgentAutonomy,
        patch: {
            enabled?: boolean;
            intervalMinutes?: number;
            policy?: BackendAgentAutonomy['policy'];
        },
    ) => {
        setAgentBusyId(agent.characterId);
        try {
            const updated = await updateBackendAgentAutonomy(persistConfig(), agent.characterId, {
                enabled: patch.enabled ?? agent.enabled,
                intervalMinutes: patch.intervalMinutes ?? agent.intervalMinutes,
                policy: patch.policy ?? agent.policy,
                timezone: resolveCharTimeZone(characters.find(character => character.id === agent.characterId))
                    || Intl.DateTimeFormat().resolvedOptions().timeZone
                    || 'UTC',
            });
            setAgents(current => current ? {
                ...current,
                agents: current.agents.map(item => item.characterId === updated.characterId ? updated : item),
            } : current);
            addToast(`${updated.name} 的 heartbeat 设置已更新`, 'success');
        } catch (error) {
            setStatus(`❌ heartbeat 更新失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setAgentBusyId(null);
        }
    };

    const setupPush = async () => {
        setBusy('push');
        try {
            const candidate = persistConfig();
            await enableBackendPush(candidate);
            const result = await testBackendPush(candidate);
            setPushConfig(await getBackendPushConfig(candidate));
            setStatus(`✅ 手机推送已连接；测试投递 ${result.delivered}/${result.attempted}`);
        } catch (error) {
            setStatus(`❌ 推送设置失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const turnOffPush = async () => {
        setBusy('disable-push');
        try {
            const candidate = persistConfig();
            await disableBackendPush(candidate);
            setPushConfig(await getBackendPushConfig(candidate));
            setStatus('✅ 本设备后台推送已关闭');
        } catch (error) {
            setStatus(`❌ 关闭推送失败：${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            setBusy(null);
        }
    };

    const configured = Boolean(config.enabled && config.token);

    return (
        <section className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.13-7.337 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">SullyOS 自主后端</h2>
                    <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full ${configured ? 'bg-teal-100 text-teal-600' : 'bg-slate-100 text-slate-400'}`}>
                        {configured ? '已配置' : '未配置'}
                    </span>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
            </div>

            {open && <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed">
                    连接你自部署的常驻后端：角色数据持久化、heartbeat 自主活动、Web Push 与外部工具都由它承担，网页关掉角色也在线。
                </p>

                <label className="block">
                    <span className="mb-1.5 block text-[10px] font-bold text-slate-500">后端地址</span>
                    <input value={config.baseUrl} onChange={event => setConfig(current => ({ ...current, baseUrl: event.target.value }))} placeholder="http://127.0.0.1:43210" spellCheck={false} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
                </label>
                <label className="block">
                    <span className="mb-1.5 block text-[10px] font-bold text-slate-500">APP Token（高级设置，首次配对不用填）</span>
                    <input type="password" value={config.token} onChange={event => setConfig(current => ({ ...current, token: event.target.value }))} placeholder="建议使用下方的一次性配对码" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
                </label>
                {!config.token.trim() && <p className="rounded-xl border border-sky-100 bg-sky-50/80 px-3 py-2.5 text-[10px] leading-relaxed text-sky-900">APP Token 是服务器内部密钥，不需要你自己创建。首次连接只要在下面输入服务器生成的 15 分钟一次性配对码。</p>}
                {!config.token.trim() && <div className="flex gap-2">
                    <input value={pairingCode} onChange={event => setPairingCode(event.target.value)} placeholder="一次性配对码" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
                    <button disabled={busy !== null || !pairingCode.trim()} onClick={() => void pair()} className="shrink-0 rounded-xl bg-sky-600 px-4 text-xs font-bold text-white transition-transform active:scale-95 disabled:opacity-50">{busy === 'pair' ? '配对中' : '配对'}</button>
                </div>}
                <div className="grid grid-cols-2 gap-2">
                    <button disabled={busy !== null} onClick={() => void connect()} className="py-2.5 rounded-xl bg-sky-600 text-xs font-bold text-white transition-transform active:scale-95 disabled:opacity-50">{busy === 'connect' ? '连接中…' : '保存并测试'}</button>
                    <button disabled={busy !== null || !config.token.trim()} onClick={() => void setupPush()} className="py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-600 transition-transform active:scale-95 disabled:opacity-50">{busy === 'push' ? '设置中…' : '连接并测试推送'}</button>
                </div>
                {config.token.trim() && <div className="space-y-2 rounded-2xl bg-slate-50/70 border border-slate-100 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <div className="text-[10px] font-bold text-slate-700">给另一台设备配对</div>
                            <div className="mt-0.5 text-[9px] text-slate-400">不会显示或复制服务器 APP Token。</div>
                        </div>
                        <button disabled={busy !== null} onClick={() => void generatePairingCode()} className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-50">{busy === 'generate-pair' ? '生成中…' : '生成配对码'}</button>
                    </div>
                    {generatedPairingCode && <div className="rounded-xl bg-white border border-slate-200 px-3 py-2 text-center font-mono text-sm font-bold tracking-[0.18em] text-slate-700">{generatedPairingCode}</div>}
                </div>}
                {pushConfig && <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50/70 border border-slate-100 px-3 py-2.5">
                    <div className="min-w-0">
                        <div className="text-[10px] font-bold text-slate-700">Web Push</div>
                        <div className="text-[9px] text-slate-400">服务器订阅 {pushConfig.activeSubscriptions} 台 · {pushConfig.configured ? '密钥已配置' : '密钥未配置'}</div>
                    </div>
                    <button disabled={busy !== null || pushConfig.activeSubscriptions === 0} onClick={() => void turnOffPush()} className="shrink-0 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-40">{busy === 'disable-push' ? '关闭中…' : '关闭本机推送'}</button>
                </div>}

                <div className="space-y-2 rounded-2xl bg-slate-50/70 border border-slate-100 p-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700">后端模型 API</span>
                        <span className="text-[9px] text-slate-400">{modelPool ? (modelPool.routing.mode === 'auto' ? '自动故障转移' : '固定模型') : '等待首次配置'}</span>
                    </div>
                    <p className="text-[10px] leading-relaxed text-slate-500">在这里填写提供商的 API 地址、API Key 和模型名。后端 heartbeat、自主活动与后端工具调用使用这里的模型，不会自动读取聊天页里只保存在当前设备上的前端 API。</p>
                    {!config.token.trim() && <p className="rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-2 text-[9px] leading-relaxed text-amber-700">请先用上方一次性配对码连接服务器，再保存模型配置。</p>}
                    {(modelPool?.profiles ?? []).map(profile => <div key={profile.id} className="flex items-center gap-2 rounded-xl bg-white border border-slate-200 px-3 py-2">
                        <button className="min-w-0 flex-1 text-left" onClick={async () => {
                            await updateBackendModelRouting(persistConfig(), { mode: 'fixed', activeProfileId: profile.id });
                            setModelPool(await getBackendModelPool(persistConfig()));
                        }}>
                            <span className="block truncate text-[10px] font-bold text-slate-700">{profile.label} · {profile.model}</span>
                            <span className="block text-[9px] text-slate-400">{modelPool?.routing.activeProfileId === profile.id ? '当前固定' : profile.healthStatus}</span>
                        </button>
                        {!profile.readOnly && <button onClick={async () => { await deleteBackendModelProfile(persistConfig(), profile.id); setModelPool(await getBackendModelPool(persistConfig())); }} className="text-[10px] font-bold text-rose-500">删除</button>}
                    </div>)}
                    {modelPool && <button onClick={async () => { await updateBackendModelRouting(persistConfig(), { mode: 'auto', activeProfileId: null }); setModelPool(await getBackendModelPool(persistConfig())); }} className="w-full rounded-lg border border-slate-200 bg-white py-2 text-[10px] font-bold text-slate-600 transition-transform active:scale-95">使用自动故障转移</button>}
                    <div className="grid grid-cols-2 gap-2">
                        <input value={newModel.label} onChange={event => setNewModel(value => ({ ...value, label: event.target.value }))} placeholder="名称" className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] text-slate-700 outline-none transition placeholder:text-slate-300" />
                        <input value={newModel.model} onChange={event => setNewModel(value => ({ ...value, model: event.target.value }))} placeholder="模型名" className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] text-slate-700 outline-none transition placeholder:text-slate-300" />
                        <input value={newModel.baseUrl} onChange={event => setNewModel(value => ({ ...value, baseUrl: event.target.value }))} placeholder="API 地址" className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] text-slate-700 outline-none transition placeholder:text-slate-300" />
                        <input type="password" value={newModel.apiKey} onChange={event => setNewModel(value => ({ ...value, apiKey: event.target.value }))} placeholder="API Key" className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] text-slate-700 outline-none transition placeholder:text-slate-300" />
                    </div>
                    {discoveredModels.length > 0 && <div className="flex flex-wrap gap-1.5">
                        {discoveredModels.map(model => <button key={model} type="button" onClick={() => setNewModel(value => ({ ...value, model }))} className={`rounded-lg border px-2.5 py-1 text-[9px] font-bold transition-colors ${newModel.model === model ? 'border-sky-500 bg-sky-500 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>{model}</button>)}
                    </div>}
                    <div className="grid grid-cols-2 gap-2">
                        <button disabled={busy !== null || !config.token.trim() || !newModel.baseUrl || !newModel.apiKey} onClick={() => void discoverModels()} className="rounded-xl border border-slate-200 bg-white py-2 text-[10px] font-bold text-slate-600 transition-transform active:scale-95 disabled:opacity-40">{busy === 'discover-models' ? '读取中…' : '自动读取模型'}</button>
                        <button disabled={busy !== null || !config.token.trim() || !newModel.baseUrl || !newModel.apiKey || !newModel.model} onClick={() => void addModel()} className="rounded-xl bg-slate-700 py-2 text-[10px] font-bold text-white transition-transform active:scale-95 disabled:opacity-40">{busy === 'model' ? '保存中…' : '保存后端模型'}</button>
                    </div>
                </div>

                <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-3 text-[10px] leading-relaxed text-amber-800">完整同步以当前手机为权威快照：相同 ID 更新而不是新增；最终 reconcile 会移除后端中手机已不存在的旧迁移副本。请先导入最完整的手机备份。</div>
                <button disabled={busy !== null || !config.token.trim()} onClick={() => void syncAll()} className="w-full py-3 rounded-2xl bg-sky-600 text-sm font-bold text-white shadow-lg shadow-sky-500/20 transition-all active:scale-95 disabled:opacity-50">{busy === 'sync' ? '正在完整同步…' : '完整同步角色、聊天与记忆宫殿'}</button>
                {status && <div className={`rounded-xl px-3 py-2.5 text-[10px] leading-relaxed ${statusToneClass(status)}`}>{status}</div>}

                {agents?.agents?.length ? <div className="space-y-3 rounded-2xl bg-slate-50/70 border border-slate-100 p-4">
                    <div>
                        <div className="text-xs font-bold text-slate-700">角色 heartbeat</div>
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">每个角色独立开关与调度；关闭只停止自主苏醒，不影响普通聊天。</p>
                    </div>
                    {agents.agents.map(agent => <div key={agent.characterId} className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                    <span className={`h-2 w-2 shrink-0 rounded-full ${agent.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                    <div className="truncate text-xs font-bold text-slate-700">{agent.name}</div>
                                </div>
                                <div className="mt-0.5 text-[9px] text-slate-400">{agent.enabled ? `下次计划：${agent.nextWakeAt ? new Date(agent.nextWakeAt).toLocaleString() : '等待调度'}` : '自主 heartbeat 已关闭'}</div>
                                {agent.lastRun && <div className={`mt-1 rounded-lg px-2 py-1 text-[9px] leading-relaxed ${agent.lastRun.status === 'failed' ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'}`}>
                                    <div>上次苏醒：{new Date(agent.lastRun.at).toLocaleString()} · {agent.lastRun.status === 'failed' ? '失败' : `动作 ${agent.lastRun.action || 'none'}`}</div>
                                    {agent.lastRun.error || agent.lastRun.reason ? <div className="mt-0.5 break-words">{agent.lastRun.error || agent.lastRun.reason}</div> : null}
                                </div>}
                            </div>
                            <button
                                type="button"
                                aria-label={`${agent.name} 自主 heartbeat`}
                                disabled={agentBusyId === agent.characterId}
                                onClick={() => void saveAgentAutonomy(agent, { enabled: !agent.enabled })}
                                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${agent.enabled ? 'bg-sky-500' : 'bg-slate-200'}`}
                            >
                                <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${agent.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                            </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
                            <label className="space-y-1">
                                <span className="text-[9px] text-slate-500">苏醒间隔</span>
                                <select value={agent.intervalMinutes} disabled={agentBusyId === agent.characterId}
                                    onChange={event => void saveAgentAutonomy(agent, { intervalMinutes: Number(event.target.value) })}
                                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] text-slate-600 outline-none">
                                    {[5, 10, 15, 30, 60, 120].map(minutes => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
                                </select>
                            </label>
                            <label className="space-y-1">
                                <span className="text-[9px] text-slate-500">空闲阈值</span>
                                <select value={agent.policy.idleThresholdMinutes} disabled={agentBusyId === agent.characterId}
                                    onChange={event => void saveAgentAutonomy(agent, { policy: { ...agent.policy, idleThresholdMinutes: Number(event.target.value) } })}
                                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] text-slate-600 outline-none">
                                    {[0, 10, 20, 30, 60, 120, 240].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? '不限制' : `${minutes} 分钟`}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1">
                                <span className="text-[9px] text-slate-500">自主活动冷却</span>
                                <select value={agent.policy.cooldownMinutes} disabled={agentBusyId === agent.characterId}
                                    onChange={event => void saveAgentAutonomy(agent, { policy: { ...agent.policy, cooldownMinutes: Number(event.target.value) } })}
                                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] text-slate-600 outline-none">
                                    {[0, 30, 60, 120, 240, 720, 1440].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? '不限制' : minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1">
                                <span className="text-[9px] text-slate-500">每日工具预算</span>
                                <select value={agent.policy.dailyToolBudget} disabled={agentBusyId === agent.characterId}
                                    onChange={event => void saveAgentAutonomy(agent, { policy: { ...agent.policy, dailyToolBudget: Number(event.target.value) } })}
                                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] text-slate-600 outline-none">
                                    {[0, 5, 10, 20, 40, 80].map(count => <option key={count} value={count}>{count === 0 ? '禁用外部工具' : `${count} 次`}</option>)}
                                </select>
                            </label>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[9px] text-slate-500">允许活动时段</span>
                                <button type="button" disabled={agentBusyId === agent.characterId}
                                    onClick={() => void saveAgentAutonomy(agent, { policy: { ...agent.policy, activityWindow: { ...agent.policy.activityWindow, enabled: !agent.policy.activityWindow.enabled } } })}
                                    className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${agent.policy.activityWindow.enabled ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-400'}`}>
                                    {agent.policy.activityWindow.enabled ? '限制中' : '全天'}
                                </button>
                            </div>
                            {agent.policy.activityWindow.enabled && <div className="flex items-center gap-2">
                                <input type="time" value={agent.policy.activityWindow.start} disabled={agentBusyId === agent.characterId}
                                    onChange={event => void saveAgentAutonomy(agent, { policy: { ...agent.policy, activityWindow: { ...agent.policy.activityWindow, start: event.target.value } } })}
                                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 outline-none" />
                                <span className="text-[9px] text-slate-400">至</span>
                                <input type="time" value={agent.policy.activityWindow.end} disabled={agentBusyId === agent.characterId}
                                    onChange={event => void saveAgentAutonomy(agent, { policy: { ...agent.policy, activityWindow: { ...agent.policy.activityWindow, end: event.target.value } } })}
                                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 outline-none" />
                            </div>}
                            <p className="text-[9px] text-slate-400">按设备时区 {agent.timezone || 'UTC'} 判断，可跨午夜。</p>
                        </div>

                        <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                            <span className="text-[9px] text-slate-500">触发概率</span>
                            <div className="flex rounded-lg bg-slate-100 p-0.5">
                                {(['low', 'mid', 'high'] as const).map(level => <button key={level} type="button"
                                    disabled={agentBusyId === agent.characterId}
                                    onClick={() => void saveAgentAutonomy(agent, { policy: { ...agent.policy, probabilityLevel: level } })}
                                    className={`rounded-md px-2 py-1 text-[9px] font-semibold ${agent.policy.probabilityLevel === level ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-400'}`}>
                                    {level === 'low' ? '低 25%' : level === 'mid' ? '中 55%' : '高 85%'}
                                </button>)}
                            </div>
                        </div>

                        <div className="border-t border-slate-100 pt-2">
                            <p className="mb-1.5 text-[9px] font-bold text-slate-500">允许自主使用的能力</p>
                            <div className="grid grid-cols-2 gap-1.5">
                                {agents.capabilities.filter(capability => capability.id !== 'memory.reflect').map(capability => {
                                    const checked = agent.policy.allowedCapabilityIds.includes(capability.id);
                                    return <button key={capability.id} type="button" title={capability.description}
                                        disabled={agentBusyId === agent.characterId}
                                        onClick={() => {
                                            const allowedCapabilityIds = checked
                                                ? agent.policy.allowedCapabilityIds.filter(id => id !== capability.id)
                                                : [...agent.policy.allowedCapabilityIds, capability.id];
                                            void saveAgentAutonomy(agent, { policy: { ...agent.policy, allowedCapabilityIds } });
                                        }}
                                        className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${checked ? 'border-sky-300 bg-white text-sky-700' : 'border-slate-200 bg-white/50 text-slate-400'}`}>
                                        <span className="block text-[9px] font-semibold">{checked ? '✓ ' : ''}{capability.label}</span>
                                        <span className="mt-0.5 block text-[8px] opacity-70">{capability.available ? '已接通' : '连接后生效'}</span>
                                    </button>;
                                })}
                            </div>
                        </div>
                    </div>)}
                </div> : !config.token.trim() ? <div className="space-y-2 rounded-2xl bg-slate-50/70 border border-slate-100 p-3">
                    <div className="text-xs font-bold text-slate-700">角色 heartbeat</div>
                    {characters.map(character => <div key={character.id} className="flex items-center gap-3 rounded-xl bg-white border border-slate-200 px-3 py-2">
                        <div className="min-w-0 flex-1"><div className="truncate text-xs font-bold text-slate-700">{character.name}</div><div className="text-[9px] text-slate-400">完成后端配对后加载开关与唤醒时间</div></div>
                        <button disabled className="rounded-full bg-slate-100 px-3 py-1.5 text-[10px] font-bold text-slate-400">待配对</button>
                    </div>)}
                </div> : null}

                <BackendToolSettings config={config} characters={characters.map(character => ({ id: character.id, name: character.name }))} onStatus={setStatus} onSaved={() => refreshRemoteState(config)} />
            </div>}
        </section>
    );
};

export default BackendSettings;
