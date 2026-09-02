export interface RuntimeCapability {
  id: string;
  label: string;
  description: string;
  risk: 'internal' | 'read' | 'write';
  available: boolean;
}

export interface AutonomyPolicy {
  allowedCapabilityIds: string[];
  approvalMode: 'read_only_auto' | 'ask_all' | 'trusted';
  maxToolStepsPerWake: number;
  dailyToolBudget: number;
  idleThresholdMinutes: number;
  cooldownMinutes: number;
  probabilityLevel: 'low' | 'mid' | 'high';
  activityWindow: {
    enabled: boolean;
    start: string;
    end: string;
  };
}

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  allowedCapabilityIds: ['memory.reflect'],
  approvalMode: 'read_only_auto',
  maxToolStepsPerWake: 1,
  dailyToolBudget: 20,
  idleThresholdMinutes: 30,
  cooldownMinutes: 60,
  probabilityLevel: 'mid',
  activityWindow: {
    enabled: false,
    start: '08:00',
    end: '23:30',
  },
};

// Adapters are deliberately registered separately from the heartbeat prompt.
// A future XHS/phone/MCP adapter only has to flip `available` after its health
// check succeeds; the decision prompt is assembled from this registry.
export const CAPABILITY_REGISTRY: RuntimeCapability[] = [
  {
    id: 'x.read',
    label: '黑 X',
    description: '浏览已登录账号的首页、主页、通知和帖子；可按 X 自己的授权设置分享卡片或点赞。',
    risk: 'read',
    available: false,
  },
  {
    id: 'memory.reflect',
    label: '整理记忆与想法',
    description: '阅读自己的上下文、整理想法，必要时写日记。',
    risk: 'internal',
    available: true,
  },
  {
    id: 'web.read',
    label: '网页探索',
    description: '搜索和阅读公开网页、新闻或论坛。',
    risk: 'read',
    available: false,
  },
  {
    id: 'xhs.read',
    label: '小红书',
    description: '浏览、搜索和查看自己的小红书主页；可按小红书自己的授权设置分享卡片或点赞。',
    risk: 'read',
    available: false,
  },
  {
    id: 'phone.read',
    label: '手机感知',
    description: '读取用户明确授权的手机状态或健康摘要。',
    risk: 'read',
    available: false,
  },
  {
    id: 'mcp.read',
    label: 'MCP 探索',
    description: '调用已连接且标记为只读的 MCP 工具。',
    risk: 'read',
    available: false,
  },
];

export function normalizeAutonomyPolicy(value: unknown): AutonomyPolicy {
  const input = value && typeof value === 'object' ? value as Partial<AutonomyPolicy> : {};
  const knownIds = new Set(CAPABILITY_REGISTRY.map((item) => item.id));
  const allowed = Array.isArray(input.allowedCapabilityIds)
    ? input.allowedCapabilityIds.filter((id): id is string => typeof id === 'string' && knownIds.has(id))
    : DEFAULT_AUTONOMY_POLICY.allowedCapabilityIds;
  if (!allowed.includes('memory.reflect')) allowed.unshift('memory.reflect');
  const rawWindow = input.activityWindow && typeof input.activityWindow === 'object'
    ? input.activityWindow
    : DEFAULT_AUTONOMY_POLICY.activityWindow;
  const normalizeClock = (clock: unknown, fallback: string) => (
    typeof clock === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock) ? clock : fallback
  );
  const boundedInteger = (raw: unknown, fallback: number, min: number, max: number) => {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.trunc(numeric))) : fallback;
  };
  return {
    allowedCapabilityIds: [...new Set(allowed)],
    approvalMode: input.approvalMode === 'ask_all' || input.approvalMode === 'trusted'
      ? input.approvalMode
      : 'read_only_auto',
    maxToolStepsPerWake: boundedInteger(input.maxToolStepsPerWake, 1, 1, 4),
    dailyToolBudget: boundedInteger(input.dailyToolBudget, 20, 0, 200),
    idleThresholdMinutes: boundedInteger(
      input.idleThresholdMinutes, DEFAULT_AUTONOMY_POLICY.idleThresholdMinutes, 0, 10_080,
    ),
    cooldownMinutes: boundedInteger(
      input.cooldownMinutes, DEFAULT_AUTONOMY_POLICY.cooldownMinutes, 0, 10_080,
    ),
    probabilityLevel: input.probabilityLevel === 'low' || input.probabilityLevel === 'high'
      ? input.probabilityLevel
      : 'mid',
    activityWindow: {
      enabled: rawWindow.enabled === true,
      start: normalizeClock(rawWindow.start, DEFAULT_AUTONOMY_POLICY.activityWindow.start),
      end: normalizeClock(rawWindow.end, DEFAULT_AUTONOMY_POLICY.activityWindow.end),
    },
  };
}

export function capabilitiesWithAvailability(connectedIds: ReadonlySet<string>): RuntimeCapability[] {
  return CAPABILITY_REGISTRY.map((item) => ({
    ...item,
    available: item.available || connectedIds.has(item.id),
  }));
}

export function availableCapabilities(
  policy: AutonomyPolicy,
  connectedIds: ReadonlySet<string> = new Set(),
): RuntimeCapability[] {
  return capabilitiesWithAvailability(connectedIds)
    .filter((item) => item.available && policy.allowedCapabilityIds.includes(item.id));
}
