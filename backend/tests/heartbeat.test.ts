import { describe, expect, it } from 'vitest';
import { availableCapabilities, normalizeAutonomyPolicy } from '../src/capabilities.js';
import {
  appendHeartbeatDecisionPrompt,
  buildHeartbeatDecisionPrompt,
  decideHeartbeat,
  evaluateHeartbeatGates,
  heartbeatProbability,
  parseDecisionContent,
  requestParsedHeartbeatDecision,
  resolveNextHeartbeatMinutes,
} from '../src/heartbeat.js';

describe('decideHeartbeat', () => {
  it('parses a valid decision surrounded by model prose or a JSON fence', () => {
    expect(parseDecisionContent('```json\n{"action":"message","reasonSummary":"想说话","content":"刚想到你。"}\n```'))
      .toMatchObject({ action: 'message', content: '刚想到你。' });
  });

  it('accepts as many proactive message bubbles as the model chooses', () => {
    expect(parseDecisionContent(JSON.stringify({
      action: 'message', reasonSummary: '想多说几句', messages: ['第一条', '第二条', '第三条'],
    }))).toMatchObject({ messages: ['第一条', '第二条', '第三条'] });
  });

  it('repairs malformed heartbeat JSON once without forcing a fixed topic', async () => {
    const calls: any[] = [];
    const complete = async (input: any) => {
      calls.push(input);
      return calls.length === 1
        ? { choices: [{ message: { content: '我决定发消息，但格式写坏了' } }] }
        : { choices: [{ message: { content: '{"action":"message","reasonSummary":"随口想说","content":"窗外那朵云有点像华夫饼。"}' } }] };
    };

    await expect(requestParsedHeartbeatDecision([
      { role: 'system', content: '角色提示' },
    ], complete as any)).resolves.toMatchObject({
      action: 'message', content: '窗外那朵云有点像华夫饼。',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1).content).toContain('不要改写成固定话题');
  });

  it('reports an explicit error after two malformed heartbeat responses', async () => {
    const complete = async () => ({ choices: [{ message: { content: 'still not json' } }] });
    await expect(requestParsedHeartbeatDecision([
      { role: 'system', content: '角色提示' },
    ], complete as any)).rejects.toThrow('模型连续两次没有返回有效的心跳决策 JSON');
  });

  it('does not create content before an AI decision provider is configured', () => {
    expect(decideHeartbeat(false)).toEqual({
      action: 'none',
      reasonSummary: 'AI 决策器尚未接入；本轮只完成低成本状态检查。',
    });
  });

  it('creates one visible message in explicit demo mode', () => {
    const decision = decideHeartbeat(true);

    expect(decision.action).toBe('message');
    expect(decision.content).toContain('本地测试消息');
  });

  it('does not expose placeholder web, phone, XHS or MCP adapters to the model', () => {
    const policy = normalizeAutonomyPolicy({
      allowedCapabilityIds: ['memory.reflect', 'web.read', 'xhs.read', 'phone.read', 'mcp.read'],
    });

    expect(availableCapabilities(policy).map((item) => item.id)).toEqual(['memory.reflect']);
    const prompt = buildHeartbeatDecisionPrompt({
      agentName: '测试角色',
      intervalMinutes: 5,
      policy,
    });
    expect(prompt).toContain('当前没有已接通的外部探索适配器');
    expect(prompt).toContain('本轮不可选择 explore');
  });

  it('keeps autonomous diaries independent and routes reactions through sticky comments', () => {
    const prompt = buildHeartbeatDecisionPrompt({
      agentName: '测试角色',
      intervalMinutes: 5,
      policy: normalizeAutonomyPolicy({}),
      diaryCandidates: [{
        id: '11111111-1111-4111-8111-111111111111',
        authorType: 'user',
        diaryDate: '2026-08-09',
        title: '今天',
        content: '用户自己的日记。',
        comments: [],
      }],
    });
    expect(prompt).toContain('属于自己的完整日记');
    expect(prompt).toContain('严禁因为读到用户的日记就写一篇对应日记');
    expect(prompt).toContain('只能选择 comment 或 none');
    expect(prompt).toContain('不要按时间顺序汇报完整的一天');
    expect(prompt).toContain('角色私下写给自己的日记');
    expect(prompt).toContain('平淡的一天也可以写');
    expect(prompt).toContain('今天发生了很多事');
    expect(prompt).toContain('只是一张排除表');
    expect(prompt).toContain('不得复用其标题、核心事件、显眼数字');
  });

  it('keeps ordinary autonomous messages open to varied life contact', () => {
    const prompt = buildHeartbeatDecisionPrompt({
      agentName: '测试角色', intervalMinutes: 5, policy: normalizeAutonomyPolicy({}),
    });
    expect(prompt).toContain('普通聊天是和 diary、comment、explore 并列的自主出口');
    expect(prompt).toContain('想念用户');
    expect(prompt).toContain('自然闲聊');
    expect(prompt).toContain('不必先使用工具');
    expect(prompt).toContain('早安、醒来后的惦记或生活开场是正常联系');
    expect(prompt).toContain('不能把旧姿势当作拒绝联系的唯一理由');
    expect(prompt).toContain('条数由你决定');
    expect(prompt).not.toContain('符合你性格和上下文的一两句');
    expect(prompt).toContain('线下共处模式和地点按当前设置持续有效');
    expect(prompt).not.toContain('所在地点等线下状态不会无期限延续');
  });

  it('does not let a model-selected silence skip the rest of the morning', () => {
    expect(resolveNextHeartbeatMinutes(5, 420)).toBe(60);
    expect(resolveNextHeartbeatMinutes(5, 30)).toBe(30);
    expect(resolveNextHeartbeatMinutes(5)).toBe(5);
  });

  it('puts the current heartbeat time after stale conversation history', () => {
    const messages = appendHeartbeatDecisionPrompt([
      { role: 'system', content: '角色设定' },
      { role: 'assistant', content: '[记录时间：2026/08/13 01:52]\n晚安。' },
    ], '当前时间：2026/08/13 09:24。');
    expect(messages.at(-1)).toEqual({
      role: 'system', content: '当前时间：2026/08/13 09:24。',
    });
  });

  it('turns off the diary action after the character has written today', () => {
    const prompt = buildHeartbeatDecisionPrompt({
      agentName: '测试角色', intervalMinutes: 5,
      policy: normalizeAutonomyPolicy({}), diaryAvailable: false,
    });
    expect(prompt).toContain('今天已经写过一篇角色日记');
    expect(prompt).toContain('零碎念头直接用 message');
  });

  it('requires the character to ask before requesting a phone screenshot', () => {
    const prompt = buildHeartbeatDecisionPrompt({
      agentName: '测试角色', intervalMinutes: 5,
      policy: normalizeAutonomyPolicy({ allowedCapabilityIds: ['phone.read'] }),
      connectedCapabilityIds: new Set(['phone.read']),
    });
    expect(prompt).toContain('必须在 content 写一句符合你本人语气');
    expect(prompt).toContain('截图回来后会作为用户图片消息进入聊天');
  });

  it('blocks autonomous decisions while the conversation is still recent', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const result = evaluateHeartbeatGates({
      policy: normalizeAutonomyPolicy({ idleThresholdMinutes: 30, probabilityLevel: 'high' }),
      timezone: 'UTC',
      lastUserActivityAt: new Date('2026-08-09T11:50:00.000Z'),
      lastAgentActivityAt: null,
      lastAutonomousActivityAt: null,
      now,
      random: () => 0,
    });
    expect(result.passed).toBe(false);
    expect(result.reasonSummary).toContain('空闲阈值');
  });

  it('uses the configured probability tiers after idle and cooldown pass', () => {
    expect(heartbeatProbability('low')).toBe(0.25);
    expect(heartbeatProbability('mid')).toBe(0.55);
    expect(heartbeatProbability('high')).toBe(0.85);
    const base = {
      policy: normalizeAutonomyPolicy({ idleThresholdMinutes: 0, cooldownMinutes: 0, probabilityLevel: 'high' }),
      timezone: 'UTC', lastUserActivityAt: null, lastAgentActivityAt: null,
      lastAutonomousActivityAt: null, now: new Date('2026-08-09T12:00:00.000Z'),
    };
    expect(evaluateHeartbeatGates({ ...base, random: () => 0.84 }).passed).toBe(true);
    expect(evaluateHeartbeatGates({ ...base, random: () => 0.85 }).passed).toBe(false);
    expect(evaluateHeartbeatGates({ ...base, random: () => 0.85 }).reasonSummary).toContain('85%');
  });

  it('supports activity windows that cross midnight', () => {
    const policy = normalizeAutonomyPolicy({
      idleThresholdMinutes: 0,
      cooldownMinutes: 0,
      probabilityLevel: 'high',
      activityWindow: { enabled: true, start: '22:00', end: '07:00' },
    });
    expect(evaluateHeartbeatGates({
      policy,
      timezone: 'UTC',
      lastUserActivityAt: null,
      lastAgentActivityAt: null,
      lastAutonomousActivityAt: null,
      now: new Date('2026-08-09T23:00:00.000Z'),
      random: () => 0,
    }).passed).toBe(true);
    expect(evaluateHeartbeatGates({
      policy,
      timezone: 'UTC',
      lastUserActivityAt: null,
      lastAgentActivityAt: null,
      lastAutonomousActivityAt: null,
      now: new Date('2026-08-09T12:00:00.000Z'),
      random: () => 0,
    }).reasonSummary).toContain('允许活动时段');
  });

  it('keeps autonomous activity cooldown ahead of the probability gate', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const policy = normalizeAutonomyPolicy({
      idleThresholdMinutes: 0,
      cooldownMinutes: 60,
      probabilityLevel: 'low',
    });
    expect(evaluateHeartbeatGates({
      policy,
      timezone: 'UTC',
      lastUserActivityAt: null,
      lastAgentActivityAt: null,
      lastAutonomousActivityAt: new Date('2026-08-09T11:30:00.000Z'),
      now,
      random: () => 0,
    }).reasonSummary).toContain('冷却中');
    expect(evaluateHeartbeatGates({
      policy,
      timezone: 'UTC',
      lastUserActivityAt: null,
      lastAgentActivityAt: null,
      lastAutonomousActivityAt: new Date('2026-08-09T10:30:00.000Z'),
      now,
      random: () => 0,
    }).reasonSummary).toContain('概率档位');
  });
});
