import React, { useEffect, useMemo, useState } from 'react';
import {
  createBackendPhonePeekTest,
  getBackendPhonePeekStatus,
  rotateBackendPhoneDeviceToken,
  type BackendChatConfig,
  type BackendPhonePeekStatus,
} from '../../utils/backendClient';

interface CharacterOption {
  id: string;
  name: string;
}

const TERMINAL_STATUSES = new Set(['analyzed', 'failed', 'expired']);

const PhoneShortcutSetup: React.FC<{
  config: BackendChatConfig;
  characters: CharacterOption[];
  initialToken?: string;
  onStatus: (message: string) => void;
}> = ({ config, characters, initialToken = '', onStatus }) => {
  const [deviceToken, setDeviceToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState(characters[0]?.id || '');
  const [goal, setGoal] = useState('想看看你现在在做什么，再自然地和你说句话。');
  const [testRequestId, setTestRequestId] = useState('');
  const [testStatus, setTestStatus] = useState<BackendPhonePeekStatus | null>(null);

  useEffect(() => {
    if (initialToken) setDeviceToken(initialToken);
  }, [initialToken]);

  useEffect(() => {
    if (!selectedCharacterId && characters[0]?.id) setSelectedCharacterId(characters[0].id);
  }, [characters, selectedCharacterId]);

  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const pendingUrl = `${baseUrl}/v1/phone/peek/pending`;
  const uploadUrl = `${baseUrl}/v1/phone/peek/upload`;
  const shortcutConfig = useMemo(() => JSON.stringify({
    deviceToken,
    pendingUrl,
    uploadUrl,
    headerName: 'X-Sully-Device-Token',
    emailSubject: 'SullyOS 屏幕查看请求',
  }, null, 2), [deviceToken, pendingUrl, uploadUrl]);

  useEffect(() => {
    if (!testRequestId || TERMINAL_STATUSES.has(testStatus?.status || '')) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await getBackendPhonePeekStatus(config, testRequestId);
        if (!cancelled) setTestStatus(next);
      } catch (error) {
        if (!cancelled) onStatus(`❌ 手机测试状态读取失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [config, onStatus, testRequestId, testStatus?.status]);

  const copy = async (value: string, label: string) => {
    if (!value) {
      onStatus(`❌ ${label}还没有生成`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      onStatus(`✅ 已复制${label}`);
    } catch {
      onStatus(`❌ 无法自动复制${label}，请长按文本手动复制`);
    }
  };

  const rotateToken = async () => {
    setBusy(true);
    try {
      const result = await rotateBackendPhoneDeviceToken(config);
      setDeviceToken(result.deviceToken);
      onStatus('✅ 已生成新的快捷指令设备令牌；旧快捷指令会立即失效');
    } catch (error) {
      onStatus(`❌ 设备令牌生成失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!selectedCharacterId) {
      onStatus('❌ 请先选择一个用于真实测试的角色');
      return;
    }
    setBusy(true);
    setTestRequestId('');
    setTestStatus(null);
    try {
      const result = await createBackendPhonePeekTest(config, {
        characterId: selectedCharacterId,
        goal: goal.trim() || undefined,
      });
      setTestRequestId(result.requestId);
      onStatus('✅ 测试邮件已发出；请保持 iPhone 已解锁，等待自动化截图并回传');
    } catch (error) {
      onStatus(`❌ 真实手机测试发起失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel: Record<string, string> = {
    pending: '等待 iPhone 回传', uploaded: '截图已上传，正在识别', analyzed: '完成',
    failed: '失败', expired: '十分钟内没有收到截图，已过期',
  };

  return (
    <div className="rounded-xl bg-slate-50/70 border border-slate-100 p-3 space-y-3">
      <div>
        <p className="text-[11px] font-bold text-slate-700">iPhone 快捷指令安装助手</p>
        <p className="mt-1 text-[9px] leading-relaxed text-slate-500">
          首台 iPhone 需要建立一次。完成后可在快捷指令里点“分享”生成 iCloud 链接，以后换设备即可一键导入。
        </p>
      </div>

      <div className="rounded-lg border border-amber-100 bg-amber-50 p-2 space-y-2">
        <p className="text-[10px] font-bold text-amber-800">1. 生成设备令牌</p>
        <p className="text-[9px] text-amber-700">更换令牌会让旧快捷指令立即失效。令牌相当于这台 iPhone 的上传钥匙，不要发给别人。</p>
        <button type="button" disabled={busy} onClick={() => void rotateToken()}
          className="w-full rounded-lg bg-amber-600 py-2 text-[10px] font-bold text-white transition-transform active:scale-95 disabled:opacity-40">
          {deviceToken ? '更换快捷指令设备令牌' : '生成快捷指令设备令牌'}
        </button>
        {deviceToken && <div className="space-y-1">
          <code className="block break-all rounded bg-white border border-slate-200 p-2 text-[9px] font-mono text-slate-600">{deviceToken}</code>
          <button type="button" onClick={() => void copy(deviceToken, '设备令牌')}
            className="w-full rounded border border-amber-200 bg-white py-1.5 text-[9px] font-bold text-amber-700 transition-transform active:scale-95">复制设备令牌</button>
        </div>}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-2 space-y-2">
        <p className="text-[10px] font-bold text-slate-700">2. 在 iPhone 建立“SullyOS 屏幕查看”</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => { window.location.href = 'shortcuts://create-shortcut'; }}
            className="rounded-lg bg-sky-600 py-2 text-[9px] font-bold text-white transition-transform active:scale-95">打开快捷指令新建页</button>
          <button type="button" onClick={() => void copy(shortcutConfig, '完整配置')}
            className="rounded-lg border border-slate-200 bg-white py-2 text-[9px] font-bold text-slate-600 transition-transform active:scale-95">复制完整配置</button>
        </div>
        <ol className="list-decimal pl-4 text-[9px] leading-relaxed text-slate-600 space-y-1">
          <li>添加“URL”，填下方待处理请求地址。</li>
          <li>添加“获取 URL 内容”：GET；标头 <b>X-Sully-Device-Token</b> 填设备令牌。</li>
          <li>从返回字典依次取 <b>data</b> 和 <b>requestId</b>；仅当 data 有值时继续。</li>
          <li>添加“拍摄屏幕快照”，再“调整图像大小”到宽 900。</li>
          <li>添加“转换图像”为 JPEG（约 55%），再“Base64 编码”。</li>
          <li>添加第二个“URL”，填下方上传地址。</li>
          <li>添加“获取 URL 内容”：POST、JSON 正文；同样加设备令牌标头。</li>
          <li>JSON 填 requestId、contentType=<b>image/jpeg</b>、imageBase64=编码结果。</li>
        </ol>
        <div className="space-y-1">
          <p className="text-[9px] font-bold text-slate-600">待处理请求地址</p>
          <code className="block break-all rounded bg-slate-50 border border-slate-100 p-2 text-[8px] font-mono text-slate-500">{pendingUrl}</code>
          <button type="button" onClick={() => void copy(pendingUrl, '待处理请求地址')}
            className="w-full rounded border border-slate-200 py-1.5 text-[9px] text-slate-500 transition-transform active:scale-95">复制</button>
          <p className="pt-1 text-[9px] font-bold text-slate-600">截图上传地址</p>
          <code className="block break-all rounded bg-slate-50 border border-slate-100 p-2 text-[8px] font-mono text-slate-500">{uploadUrl}</code>
          <button type="button" onClick={() => void copy(uploadUrl, '截图上传地址')}
            className="w-full rounded border border-slate-200 py-1.5 text-[9px] text-slate-500 transition-transform active:scale-95">复制</button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-2 space-y-2">
        <p className="text-[10px] font-bold text-slate-700">3. 建立邮件个人自动化</p>
        <p className="text-[9px] leading-relaxed text-slate-600">
          快捷指令 → 自动化 → 新建个人自动化 → 邮件。发件人选择上面配置的 SMTP 账号，主题包含
          <b> SullyOS 屏幕查看请求</b>（为兼容旧自动化保留该邮件主题），动作选择“运行快捷指令”并运行“SullyOS 屏幕查看”，设为立即运行。
        </p>
        <p className="text-[9px] text-amber-700">截屏时 iPhone 必须处于已解锁、可截图状态；锁屏、受保护视频或部分银行 App 可能只返回空白画面。</p>
      </div>

      <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-2 space-y-2">
        <p className="text-[10px] font-bold text-emerald-800">4. 真实端到端测试</p>
        <select value={selectedCharacterId} onChange={(event) => setSelectedCharacterId(event.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-[10px] text-slate-600 outline-none">
          <option value="">选择测试角色</option>
          {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select>
        <input value={goal} onChange={(event) => setGoal(event.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-[10px] text-slate-600 outline-none placeholder:text-slate-300" placeholder="角色为什么想来看看" />
        <button type="button" disabled={busy || !deviceToken || !selectedCharacterId} onClick={() => void runTest()}
          className="w-full rounded-lg bg-emerald-600 py-2 text-[10px] font-bold text-white transition-transform active:scale-95 disabled:opacity-40">发送真实测试邮件并等待 iPhone</button>
        {!deviceToken && <p className="text-[9px] text-amber-700">先生成设备令牌并填入快捷指令，真实测试按钮才会启用。</p>}
        {testRequestId && <div className="rounded-lg bg-white border border-slate-200 p-2 text-[9px] text-slate-600 space-y-1">
          <p><b>请求：</b>{testRequestId}</p>
          <p><b>状态：</b>{statusLabel[testStatus?.status || 'pending'] || testStatus?.status}</p>
          {testStatus?.analysis && <p><b>客观识别：</b>{testStatus.analysis}</p>}
          {testStatus?.reaction?.content && <p className="text-emerald-700"><b>{testStatus.characterName} 发出的角色反应：</b>{testStatus.reaction.content}</p>}
        </div>}
      </div>
    </div>
  );
};

export default PhoneShortcutSetup;
