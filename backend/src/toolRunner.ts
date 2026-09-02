import type { PoolClient } from 'pg';
import { z } from 'zod';
import { createChatCompletion } from './modelClient.js';
import { createPhonePeekRequest } from './phonePeek.js';
import { getToolConnection, type ToolConnection } from './toolConnections.js';
import type { ToolShareCandidate } from './toolDigestion.js';

const toolChoiceSchema = z.object({
  toolName: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export interface ToolRunResult {
  status: 'planned' | 'completed' | 'failed';
  eventType: 'autonomous_activity' | 'mcp_activity' | 'tool_activity';
  title: string;
  toolName: string;
  summary: string;
  rawResult?: unknown;
  shareCandidates?: ToolShareCandidate[];
  permissions?: {
    shareToChat: boolean;
    like: boolean;
    repost: boolean;
  };
  metadata?: Record<string, unknown>;
}

function bounded(value: unknown, max = 12_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  return text.length <= max ? text : `${text.slice(0, max)}\n[工具结果已截断]`;
}

function parseJsonObject(text: string): unknown {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('模型没有返回工具选择 JSON。');
  return JSON.parse(text.slice(first, last + 1));
}

function isProbablyWriteTool(name: string): boolean {
  return /(?:^|[_.-])(post|publish|delete|remove|like|comment|reply|send|write|create|update|purchase|order)(?:$|[_.-])/i.test(name);
}

function settingEnabled(connection: ToolConnection, key: string, fallback: boolean): boolean {
  const value = connection.settings[key];
  return typeof value === 'boolean' ? value : fallback;
}

function platformPermissions(connection: ToolConnection) {
  if (connection.id === 'x.read') {
    return { shareToChat: true, like: true, repost: true };
  }
  if (connection.id === 'web.read') {
    return { shareToChat: true, like: false, repost: false };
  }
  return {
    shareToChat: settingEnabled(connection, 'allowShareToChat', true),
    like: settingEnabled(connection, 'allowLike', true),
    repost: false,
  };
}

interface McpPoolServer {
  id: string;
  name: string;
  url: string;
  tools: Array<Record<string, unknown>>;
}

function mcpPoolServers(connection: ToolConnection): Array<{ server: McpPoolServer; connection: ToolConnection }> {
  const rawServers = Array.isArray(connection.settings.servers) ? connection.settings.servers : [];
  return rawServers.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = value as Record<string, unknown>;
    const id = String(raw.id || '').trim();
    const url = String(raw.url || '').trim();
    const tools = Array.isArray(raw.tools)
      ? raw.tools.filter((tool): tool is Record<string, unknown> => Boolean(tool && typeof tool === 'object' && !Array.isArray(tool)))
      : [];
    if (!id || !url || tools.length === 0) return [];
    let privateConfig: { token?: string; customHeaders?: Array<{ name?: string; value?: string }> } = {};
    try {
      privateConfig = JSON.parse(connection.credentials[`server:${id}`] || '{}');
    } catch { /* invalid saved secret behaves like missing credentials */ }
    const headers = Object.fromEntries((privateConfig.customHeaders || [])
      .filter((item) => item?.name && item?.value)
      .map((item) => [String(item.name), String(item.value)]));
    return [{
      server: { id, name: String(raw.name || id), url, tools },
      connection: {
        ...connection,
        endpoint: url,
        settings: { mode: 'mcp', requestHeaders: headers },
        credentials: { bearerToken: String(privateConfig.token || '') },
      },
    }];
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 45_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function endpointHeaders(connection: ToolConnection, extra: Record<string, string> = {}): Record<string, string> {
  const token = connection.credentials.bearerToken || connection.credentials.token;
  const requestHeaders = connection.settings.requestHeaders && typeof connection.settings.requestHeaders === 'object'
    && !Array.isArray(connection.settings.requestHeaders)
    ? Object.fromEntries(Object.entries(connection.settings.requestHeaders)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0])))
    : {};
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...requestHeaders,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!response.ok) throw new Error(`工具服务返回 HTTP ${response.status}：${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch {
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(dataLines[index]!.slice(5).trim()); } catch { /* next line */ }
    }
    throw new Error('工具服务没有返回可解析的 JSON。');
  }
}

async function mcpRpc(
  connection: ToolConnection,
  method: string,
  params: Record<string, unknown>,
  id: number,
  sessionId?: string,
): Promise<{ body: any; sessionId?: string }> {
  const response = await fetchWithTimeout(connection.endpoint, {
    method: 'POST',
    headers: endpointHeaders(connection, sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { body: await responseJson(response), sessionId: response.headers.get('mcp-session-id') || sessionId };
}

function unwrapMcpResult(body: any): unknown {
  const result = body?.result ?? body;
  const content = result?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string);
    if (texts.length === 1) {
      try { return JSON.parse(texts[0]!); } catch { return texts[0]; }
    }
    if (texts.length > 1) return texts;
  }
  return result;
}

function collectObjects(value: unknown, output: Record<string, any>[], depth = 0): void {
  if (depth > 7 || output.length >= 160 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, any>;
  output.push(record);
  for (const nested of Object.values(record)) collectObjects(nested, output, depth + 1);
}

function firstString(...values: unknown[]): string {
  return values.find((value) => typeof value === 'string' && value.trim())?.toString().trim() ?? '';
}

function nestedRecords(value: unknown): Record<string, any>[] {
  const records: Record<string, any>[] = [];
  collectObjects(value, records);
  return records;
}

function firstNestedString(records: Record<string, any>[], keys: string[]): string {
  for (const record of records) {
    const value = firstString(...keys.map((key) => record[key]));
    if (value) return value;
  }
  return '';
}

function firstNestedCount(records: Record<string, any>[], keys: string[]): number {
  for (const record of records) {
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw !== 'number' && typeof raw !== 'string') continue;
      const value = Number(String(raw).replace(/,/g, ''));
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return 0;
}

const X_MEDIA_URL_KEYS = new Set([
  'image', 'imageUrl', 'image_url', 'mediaUrl', 'media_url', 'preview_image_url',
  'thumbnail', 'thumbnailUrl', 'thumbnail_url',
]);
const X_MEDIA_CONTAINER_KEYS = new Set(['attachments', 'media', 'photos', 'images']);

function collectXMediaUrls(
  value: unknown,
  targetStatusId: string,
  output: string[],
  depth = 0,
  insideMedia = false,
): void {
  if (depth > 7 || output.length >= 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectXMediaUrls(item, targetStatusId, output, depth + 1, insideMedia);
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const nestedUrl = firstString(record.url, record.tweet_url, record.tweetUrl, record.status_url, record.permalink);
  const nestedStatusId = xStatusId(nestedUrl);
  if (nestedStatusId && targetStatusId && nestedStatusId !== targetStatusId) return;

  for (const [key, nested] of Object.entries(record)) {
    const isStatusRecord = depth === 0 || nestedStatusId === targetStatusId;
    const isMediaUrl = (X_MEDIA_URL_KEYS.has(key) && (insideMedia || isStatusRecord))
      || (insideMedia && key === 'url');
    if (isMediaUrl && typeof nested === 'string' && /^https?:\/\//i.test(nested.trim())) {
      const url = nested.trim();
      if (!output.includes(url)) output.push(url);
      if (output.length >= 4) return;
    }
    collectXMediaUrls(nested, targetStatusId, output, depth + 1, insideMedia || X_MEDIA_CONTAINER_KEYS.has(key));
  }
}

export function extractXShareCandidates(value: unknown): ToolShareCandidate[] {
  const objects: Record<string, any>[] = [];
  collectObjects(value, objects);
  const seen = new Set<string>();
  const candidates: ToolShareCandidate[] = [];
  for (const item of objects) {
    const records = nestedRecords(item);
    const url = firstString(item.url, item.tweet_url, item.tweetUrl, item.status_url, item.permalink);
    if (!/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/.+\/status\/\d+/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const description = firstNestedString(records, ['text', 'full_text', 'fullText', 'content', 'description']);
    const handle = firstNestedString(records, ['handle', 'username', 'screen_name', 'screenName']);
    const displayName = firstNestedString(records, ['author_name', 'authorName', 'display_name', 'displayName', 'name']);
    const author = firstString(
      typeof item.author === 'string' ? item.author : '',
      handle && `@${handle.replace(/^@/, '')}`,
      displayName,
    );
    const mediaUrls: string[] = [];
    collectXMediaUrls(item, xStatusId(url), mediaUrls);
    const imageUrl = mediaUrls[0];
    const likes = firstNestedCount(records, ['like_count', 'likes', 'likeCount', 'favorite_count', 'favoriteCount']);
    const retweets = firstNestedCount(records, [
      'retweet_count', 'retweets', 'retweetCount', 'repost_count', 'reposts', 'repostCount',
    ]);
    candidates.push({
      platform: 'x', url,
      title: description.slice(0, 100) || `${author || 'X 用户'} 的帖子`,
      description: description.slice(0, 1_200), author, imageUrl, mediaUrls,
      likes,
      retweets,
    });
    if (candidates.length >= 12) break;
  }
  return candidates;
}

export function extractXhsShareCandidates(value: unknown): ToolShareCandidate[] {
  const objects: Record<string, any>[] = [];
  collectObjects(value, objects);
  const seen = new Set<string>();
  const candidates: ToolShareCandidate[] = [];
  for (const raw of objects) {
    const item = raw.noteCard || raw.note_card || raw.note || raw;
    const noteId = firstString(item.noteId, item.note_id, item.id, raw.noteId, raw.note_id);
    if (!/^[a-f0-9]{24}$/i.test(noteId) || seen.has(noteId)) continue;
    const title = firstString(item.title, item.displayTitle, item.display_title, raw.title);
    const description = firstString(item.desc, item.description, item.content, raw.desc);
    if (!title && !description) continue;
    seen.add(noteId);
    const xsecToken = firstString(raw.xsecToken, raw.xsec_token, item.xsecToken, item.xsec_token);
    const user = item.user || item.userInfo || item.user_info || raw.user || {};
    const author = firstString(item.author, item.nickname, user.nickname, user.name);
    const cover = item.cover || raw.cover || {};
    const imageUrl = firstString(item.coverUrl, item.cover_url, cover.urlDefault, cover.url_default, cover.url);
    const likes = Number(item.likes ?? item.liked_count ?? item.interactInfo?.likedCount
      ?? item.interact_info?.liked_count ?? 0) || 0;
    candidates.push({
      platform: 'xhs', noteId, xsecToken,
      url: `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed` : ''}`,
      title: title || description.slice(0, 80) || '小红书笔记',
      description: description.slice(0, 1_200), author, imageUrl, likes,
    });
    if (candidates.length >= 12) break;
  }
  return candidates;
}

async function chooseMcpTool(goal: string, tools: Array<Record<string, unknown>>): Promise<{ toolName: string; arguments: Record<string, unknown> }> {
  const safeTools = tools.slice(0, 80).map((tool) => ({
    name: tool.name,
    description: bounded(tool.description, 1_000),
    inputSchema: tool.inputSchema,
  }));
  const completion = await createChatCompletion({
    messages: [{
      role: 'system',
      content: `你负责为一次只读自主探索选择恰好一个 MCP 工具。目标：${goal}\n可用工具：${bounded(safeTools, 30_000)}\n只能选择真正只读的工具，不得选择发帖、评论、点赞、删除、购买、发送或修改外部内容的工具。只返回 JSON：{"toolName":"清单中的精确名称","arguments":{}}`,
    }],
    temperature: 0.2,
    maxTokens: 1_200,
  });
  const first = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : '';
  return toolChoiceSchema.parse(parseJsonObject(typeof content === 'string' ? content : ''));
}

export function chooseXReadTool(
  connection: ToolConnection,
  goal: string,
  tools: Array<Record<string, unknown>>,
): { toolName: string; arguments: Record<string, unknown> } {
  const names = new Set(tools.map((tool) => String(tool.name || '')));
  const normalized = goal.trim();
  if (/通知|notification/i.test(normalized) && names.has('x_read_notifications')) {
    return { toolName: 'x_read_notifications', arguments: { count: 15 } };
  }
  const explicitUser = normalized.match(/(?:用户|主页|账号)\s*[:：]\s*@?([A-Za-z0-9_]+)/i)?.[1];
  const wantsOwnProfile = /我的主页|自己(?:的)?主页|我转发|自己的动态/i.test(normalized);
  const wantsProfile = Boolean(explicitUser || wantsOwnProfile);
  const user = explicitUser || (wantsOwnProfile ? firstString(connection.settings.selfHandle) : '');
  if (user && names.has('x_read_timeline')) {
    return { toolName: 'x_read_timeline', arguments: { user, count: 20 } };
  }
  if (wantsOwnProfile && !user) throw new Error('X 工具没有保存你的账号 handle，无法读取“我的主页”。');
  if (wantsProfile) throw new Error('当前 X 桥接器没有提供用户主页读取工具。');
  if (names.has('x_read_home')) return { toolName: 'x_read_home', arguments: { count: 18 } };
  const fallback = tools.find((tool) => !isProbablyWriteTool(String(tool.name || '')));
  if (!fallback?.name) throw new Error('X 桥接器没有可用的读取工具。');
  return { toolName: String(fallback.name), arguments: {} };
}

async function runMcp(connection: ToolConnection, goal: string): Promise<ToolRunResult> {
  const initialized = await mcpRpc(connection, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sullyos-autonomy', version: '1.0.0' },
  }, 1);
  const listed = await mcpRpc(connection, 'tools/list', {}, 2, initialized.sessionId);
  const tools = Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools as Array<Record<string, unknown>> : [];
  if (tools.length === 0) throw new Error('MCP 服务没有提供工具。');
  const choice = connection.id === 'x.read'
    ? chooseXReadTool(connection, goal, tools)
    : await chooseMcpTool(goal, tools);
  const allowlist = Array.isArray(connection.settings.readToolAllowlist)
    ? connection.settings.readToolAllowlist.filter((item): item is string => typeof item === 'string')
    : [];
  if (isProbablyWriteTool(choice.toolName) && !allowlist.includes(choice.toolName)) {
    throw new Error(`已阻止疑似写操作工具：${choice.toolName}`);
  }
  if (!tools.some((tool) => tool.name === choice.toolName)) throw new Error('模型选择了不存在的 MCP 工具。');
  const called = await mcpRpc(connection, 'tools/call', {
    name: choice.toolName,
    arguments: choice.arguments,
  }, 3, listed.sessionId);
  if (called.body?.error) throw new Error(bounded(called.body.error, 1_000));
  const rawResult = unwrapMcpResult(called.body);
  const shareCandidates = connection.id === 'x.read'
    ? extractXShareCandidates(rawResult)
    : connection.id === 'xhs.read' ? extractXhsShareCandidates(rawResult) : [];
  const summary = connection.id === 'x.read'
    ? `在 X 看了 ${shareCandidates.length || '一些'} 条内容，结果已经交给角色本人。`
    : connection.id === 'xhs.read'
      ? `在小红书看了 ${shareCandidates.length || '一些'} 条内容，结果已经交给角色本人。`
      : bounded(rawResult, 4_000);
  return {
    status: 'completed', eventType: connection.id === 'mcp.read' ? 'mcp_activity' : 'autonomous_activity',
    title: connection.id === 'x.read' ? '去 X 看了一会儿'
      : connection.id === 'xhs.read' ? '逛了逛小红书' : 'MCP 自主探索',
    toolName: choice.toolName, summary, rawResult, shareCandidates,
    permissions: connection.id === 'mcp.read' ? { shareToChat: false, like: false, repost: false } : platformPermissions(connection),
    metadata: { arguments: choice.arguments },
  };
}

async function runMcpPool(connection: ToolConnection, goal: string): Promise<ToolRunResult> {
  const servers = mcpPoolServers(connection);
  if (servers.length === 0) throw new Error('还没有同步已启用且完成工具发现的 MCP 服务器。');
  const selectable = servers.flatMap(({ server }) => server.tools.map((tool) => ({
    name: `${server.id}::${String(tool.name || '')}`,
    description: `[${server.name}] ${String(tool.description || '')}`,
    inputSchema: tool.inputSchema,
  })).filter((tool) => !tool.name.endsWith('::')));
  const choice = await chooseMcpTool(goal, selectable);
  const separator = choice.toolName.indexOf('::');
  const serverId = choice.toolName.slice(0, separator);
  const toolName = choice.toolName.slice(separator + 2);
  const selected = servers.find((item) => item.server.id === serverId);
  if (!selected || !selected.server.tools.some((tool) => tool.name === toolName)) {
    throw new Error('模型选择了不存在的 MCP 工具。');
  }
  if (isProbablyWriteTool(toolName)) throw new Error(`自主探索不能调用有副作用的 MCP 工具：${toolName}`);
  const initialized = await mcpRpc(selected.connection, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'sullyos-autonomy', version: '1.0.0' },
  }, 1);
  const called = await mcpRpc(selected.connection, 'tools/call', {
    name: toolName, arguments: choice.arguments,
  }, 2, initialized.sessionId);
  if (called.body?.error) throw new Error(bounded(called.body.error, 1_000));
  const rawResult = unwrapMcpResult(called.body);
  return {
    status: 'completed', eventType: 'mcp_activity', title: `使用了 ${selected.server.name}`,
    toolName, summary: bounded(rawResult, 4_000), rawResult,
    permissions: { shareToChat: false, like: false, repost: false },
    metadata: { serverId, serverName: selected.server.name, arguments: choice.arguments },
  };
}

async function runBridge(connection: ToolConnection, goal: string): Promise<ToolRunResult> {
  const response = await fetchWithTimeout(connection.endpoint, {
    method: 'POST',
    headers: endpointHeaders(connection),
    body: JSON.stringify({ action: 'read', goal }),
  });
  const body = await responseJson(response);
  const summary = bounded(body?.data?.summary ?? body?.summary ?? body?.data ?? body, 8_000);
  return {
    status: 'completed', eventType: 'tool_activity',
    title: connection.id === 'x.read' ? '去 X 看了一会儿' : '自主探索',
    toolName: String(body?.data?.toolName ?? body?.toolName ?? connection.id), summary,
  };
}

function xSessionUrl(connection: ToolConnection, path: 'status' | 'cookies'): string {
  const url = new URL(connection.endpoint);
  url.pathname = `/session/${path}`;
  url.search = '';
  return url.toString();
}

export async function getXSessionStatus(connection: ToolConnection): Promise<{ loggedIn: boolean; hasCt0: boolean; pageUrl: string; selfHandle: string }> {
  const response = await fetchWithTimeout(xSessionUrl(connection, 'status'), {
    method: 'GET', headers: endpointHeaders(connection),
  }, 20_000);
  const body = await responseJson(response);
  return {
    loggedIn: Boolean(body?.data?.loggedIn),
    hasCt0: Boolean(body?.data?.hasCt0),
    pageUrl: String(body?.data?.pageUrl || ''),
    selfHandle: String(body?.data?.selfHandle || ''),
  };
}

export async function updateXSessionCookies(connection: ToolConnection, input: { authToken: string; ct0?: string }): Promise<{ loggedIn: boolean; hasCt0: boolean; pageUrl: string; selfHandle: string }> {
  const response = await fetchWithTimeout(xSessionUrl(connection, 'cookies'), {
    method: 'POST', headers: endpointHeaders(connection), body: JSON.stringify(input),
  }, 35_000);
  const body = await responseJson(response);
  return {
    loggedIn: Boolean(body?.data?.loggedIn),
    hasCt0: Boolean(body?.data?.hasCt0),
    pageUrl: String(body?.data?.pageUrl || ''),
    selfHandle: String(body?.data?.selfHandle || ''),
  };
}

function xhsLiteUrl(connection: ToolConnection, command: string): string {
  const base = connection.endpoint.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/${command}`;
}

async function xhsLitePost(connection: ToolConnection, command: string, body: Record<string, unknown> = {}): Promise<any> {
  const cookie = connection.credentials.cookie;
  if (!cookie) throw new Error('小红书 Cookie 尚未保存到后端。');
  const response = await fetchWithTimeout(xhsLiteUrl(connection, command), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-xhs-cookie': cookie },
    body: JSON.stringify(body),
  });
  const result = await responseJson(response);
  if (result?.success === false) throw new Error(firstString(result.error, result.message) || `小红书 ${command} 执行失败。`);
  return result;
}

function xhsSearchKeyword(goal: string): string {
  return goal.match(/(?:搜索|查找|搜)\s*[:：]\s*(.+)$/i)?.[1]?.trim().slice(0, 80) || '';
}

async function runXhsLite(connection: ToolConnection, goal: string): Promise<ToolRunResult> {
  const wantsProfile = /我的主页|自己(?:的)?主页|我(?:收藏|发布|发过)|自己的笔记/i.test(goal);
  const keyword = xhsSearchKeyword(goal);
  let command = 'list-feeds';
  let args: Record<string, unknown> = {};
  if (wantsProfile && firstString(connection.settings.userId)) {
    command = 'user-profile';
    args = { user_id: firstString(connection.settings.userId), xsec_token: firstString(connection.settings.userXsecToken) };
  } else if (keyword) {
    command = 'search';
    args = { keyword };
  }
  const result = await xhsLitePost(connection, command, args);
  const shareCandidates = extractXhsShareCandidates(result);
  return {
    status: 'completed',
    eventType: 'autonomous_activity',
    title: command === 'search' ? `在小红书搜了“${keyword}”` : command === 'user-profile' ? '看了看自己的小红书主页' : '逛了逛小红书',
    toolName: `xhs_${command.replace(/-/g, '_')}`,
    summary: `在小红书看了 ${shareCandidates.length || '一些'} 条内容，结果已经交给角色本人。`,
    rawResult: result,
    shareCandidates,
    permissions: platformPermissions(connection),
  };
}

export async function readXFeed(input: { view: 'home' | 'notifications' | 'profile'; handle?: string; owner?: 'user' | 'character' }): Promise<{ items: ToolShareCandidate[]; view: string; fetchedAt: string }> {
  const connection = await getToolConnection('x.read');
  if (!connection?.enabled || !connection.endpoint) throw new Error('X 工具尚未启用或未配置');
  const configuredHandle = input.owner === 'user'
    ? firstString(connection.settings.userHandle)
    : input.owner === 'character' ? firstString(connection.settings.selfHandle) : '';
  if (input.view === 'profile' && input.owner === 'user' && !configuredHandle) {
    throw new Error('尚未配置用户的 X 用户名，无法读取用户主页。');
  }
  if (input.view === 'profile' && input.owner === 'character' && !configuredHandle) {
    throw new Error('尚未识别角色登录的 X 用户名，无法读取角色主页。');
  }
  const handle = input.handle || configuredHandle;
  const goal = input.view === 'notifications' ? '通知' : input.view === 'profile'
    ? `主页: ${handle}` : '首页';
  const result = await runMcp(connection, goal);
  return { items: result.shareCandidates || [], view: input.view, fetchedAt: new Date().toISOString() };
}

export interface XFollowingAccount {
  handle: string;
  name: string;
  bio: string;
}

function xFollowingTool(tools: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const exactNames = ['x_read_following', 'x_read_friends', 'x_read_following_list'];
  for (const name of exactNames) {
    const tool = tools.find(candidate => String(candidate.name || '').toLowerCase() === name);
    if (tool) return tool;
  }
  return tools.find(tool => /^(?:x_)?(?:read|get|list)_(?:following|friends|following_list)$/i.test(String(tool.name || ''))
    && !isProbablyWriteTool(String(tool.name || '')));
}

function xFollowingToolArguments(tool: Record<string, unknown>, selfHandle: string): Record<string, unknown> {
  const inputSchema = tool.inputSchema;
  const properties = inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
    ? (inputSchema as { properties?: Record<string, unknown> }).properties || {}
    : {};
  const args: Record<string, unknown> = {};
  if (selfHandle) {
    for (const key of ['user', 'username', 'handle', 'screen_name']) {
      if (key in properties) {
        args[key] = selfHandle.replace(/^@/, '');
        break;
      }
    }
  }
  for (const key of ['count', 'limit', 'max_results']) {
    if (key in properties) {
      args[key] = 50;
      break;
    }
  }
  return args;
}

export function extractXFollowingAccounts(value: unknown): XFollowingAccount[] {
  const objects: Record<string, any>[] = [];
  collectObjects(value, objects);
  const accounts: XFollowingAccount[] = [];
  const seen = new Set<string>();
  for (const item of objects) {
    const handle = firstString(item.handle, item.username, item.screen_name, item.screenName).replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,50}$/.test(handle) || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    accounts.push({
      handle,
      name: firstString(item.display_name, item.displayName, item.name),
      bio: firstString(item.bio, item.description).slice(0, 500),
    });
    if (accounts.length >= 50) break;
  }
  return accounts;
}

export async function readXFollowing(): Promise<{ accounts: XFollowingAccount[]; fetchedAt: string }> {
  const connection = await getToolConnection('x.read');
  if (!connection?.enabled || !connection.endpoint) throw new Error('X 工具尚未启用或未配置');
  const initialized = await mcpRpc(connection, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'sullyos-chat', version: '1.0.0' },
  }, 1);
  const listed = await mcpRpc(connection, 'tools/list', {}, 2, initialized.sessionId);
  const tools = Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools as Array<Record<string, unknown>> : [];
  const tool = xFollowingTool(tools);
  if (!tool?.name) throw new Error('当前 X 桥接器没有提供关注列表读取工具。');
  const called = await mcpRpc(connection, 'tools/call', {
    name: String(tool.name),
    arguments: xFollowingToolArguments(tool, firstString(connection.settings.selfHandle)),
  }, 3, listed.sessionId);
  if (called.body?.error) throw new Error(bounded(called.body.error, 1_000));
  return {
    accounts: extractXFollowingAccounts(unwrapMcpResult(called.body)),
    fetchedAt: new Date().toISOString(),
  };
}

export function xStatusToolArguments(tool: Record<string, unknown>, url: string): Record<string, string> {
  const inputSchema = tool.inputSchema;
  const properties = inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
    ? (inputSchema as { properties?: Record<string, unknown> }).properties || {}
    : {};
  if ('url_or_id' in properties) return { url_or_id: url };
  if ('url' in properties) return { url };
  if ('tweet_url' in properties) return { tweet_url: url };
  if ('status_url' in properties) return { status_url: url };
  return { url_or_id: url };
}

function xTimelineToolArguments(tool: Record<string, unknown>, handle: string): Record<string, unknown> {
  const inputSchema = tool.inputSchema;
  const properties = inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
    ? (inputSchema as { properties?: Record<string, unknown> }).properties || {}
    : {};
  const args: Record<string, unknown> = {};
  for (const key of ['user', 'username', 'handle', 'screen_name']) {
    if (key in properties) {
      args[key] = handle;
      break;
    }
  }
  for (const key of ['count', 'limit', 'max_results']) {
    if (key in properties) {
      args[key] = 30;
      break;
    }
  }
  return args;
}

function xStatusId(url: string): string {
  return url.match(/\/(?:status)\/(\d+)/i)?.[1] || '';
}

export function matchingXStatus(candidates: ToolShareCandidate[], url: string): ToolShareCandidate | null {
  const targetId = xStatusId(url);
  if (!targetId) return null;
  return candidates.find(candidate => xStatusId(candidate.url) === targetId) || null;
}

export async function readXStatus(url: string): Promise<ToolShareCandidate | null> {
  const connection = await getToolConnection('x.read');
  if (!connection?.enabled || !connection.endpoint) throw new Error('X 工具尚未启用或未配置');
  const initialized = await mcpRpc(connection, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'sullyos-chat', version: '1.0.0' },
  }, 1);
  const listed = await mcpRpc(connection, 'tools/list', {}, 2, initialized.sessionId);
  const tools = Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools as Array<Record<string, unknown>> : [];
  const detail = tools.find(tool => /(?:read|fetch|get|view).*(?:tweet|status|post)|(?:tweet|status|post).*(?:read|fetch|get|view)/i.test(String(tool.name || '')) && !isProbablyWriteTool(String(tool.name || '')))
    || tools.find(tool => String(tool.name || '') === 'x_read_home');
  if (!detail?.name) return null;
  const called = await mcpRpc(connection, 'tools/call', {
    name: String(detail.name),
    arguments: String(detail.name) === 'x_read_home'
      ? { count: 30, url, query: url }
      : xStatusToolArguments(detail, url),
  }, 3, listed.sessionId);
  if (called.body?.error) throw new Error(bounded(called.body.error, 1_000));
  const detailCandidates = extractXShareCandidates(unwrapMcpResult(called.body));
  const candidate = matchingXStatus(detailCandidates, url);
  if (!candidate || candidate.imageUrl) return candidate;

  const parsedUrl = url.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/\d+/i);
  const handle = parsedUrl?.[1]?.replace(/^@/, '') || '';
  const enrichmentTools = [
    handle ? tools.find(tool => String(tool.name || '') === 'x_read_timeline') : undefined,
    tools.find(tool => String(tool.name || '') === 'x_read_home'),
  ].filter((tool, index, all): tool is Record<string, unknown> => Boolean(tool?.name)
    && all.findIndex(other => other?.name === tool?.name) === index);

  for (let index = 0; index < enrichmentTools.length; index += 1) {
    const tool = enrichmentTools[index]!;
    try {
      const enriched = await mcpRpc(connection, 'tools/call', {
        name: String(tool.name),
        arguments: String(tool.name) === 'x_read_timeline'
          ? xTimelineToolArguments(tool, handle)
          : { count: 30 },
      }, 4 + index, called.sessionId);
      if (enriched.body?.error) continue;
      const exact = matchingXStatus(extractXShareCandidates(unwrapMcpResult(enriched.body)), url);
      if (exact?.mediaUrls?.length) {
        return { ...candidate, mediaUrls: exact.mediaUrls, imageUrl: exact.mediaUrls[0] };
      }
    } catch {
      // The detail result remains useful even when optional media enrichment is unavailable.
    }
  }
  return candidate;
}

export async function runWebSearch(connection: ToolConnection, goal: string): Promise<ToolRunResult> {
  const endpoint = connection.endpoint || 'https://api.search.brave.com/res/v1/web/search';
  const apiKey = connection.credentials.bearerToken || connection.credentials.apiKey;
  if (!apiKey) throw new Error('网页探索还没有保存 Brave Search API Key。');
  const url = new URL(endpoint);
  url.searchParams.set('q', goal.trim() || '今天值得留意的新闻');
  url.searchParams.set('count', '10');
  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  }, 25_000);
  const result = await responseJson(response);
  const rows = Array.isArray(result?.web?.results) ? result.web.results as Array<Record<string, unknown>> : [];
  const candidates = rows.flatMap((item): ToolShareCandidate[] => {
    const itemUrl = firstString(item.url);
    if (!/^https?:\/\//i.test(itemUrl)) return [];
    return [{
      platform: 'web',
      url: itemUrl,
      title: firstString(item.title) || itemUrl,
      description: firstString(item.description).slice(0, 1_200),
      author: firstString(item.profile && typeof item.profile === 'object'
        ? (item.profile as Record<string, unknown>).long_name
        : '', item.meta_url && typeof item.meta_url === 'object'
          ? (item.meta_url as Record<string, unknown>).hostname
          : ''),
      imageUrl: firstString(item.thumbnail && typeof item.thumbnail === 'object'
        ? (item.thumbnail as Record<string, unknown>).src
        : ''),
    }];
  }).slice(0, 12);
  return {
    status: 'completed',
    eventType: 'autonomous_activity',
    title: `搜索网页“${(goal.trim() || '今天值得留意的新闻').slice(0, 80)}”`,
    toolName: 'brave_web_search',
    summary: `搜索了网页，找到 ${candidates.length} 条可读结果，已经交给角色本人。`,
    rawResult: { query: goal, results: rows.slice(0, 12) },
    shareCandidates: candidates,
    permissions: platformPermissions(connection),
  };
}

export async function performPlatformLike(
  capabilityId: 'x.read' | 'xhs.read',
  candidate: ToolShareCandidate,
): Promise<string> {
  const connection = await getToolConnection(capabilityId);
  if (!connection?.enabled || (capabilityId === 'xhs.read' && !settingEnabled(connection, 'allowLike', true))) {
    throw new Error('该平台没有授权自主点赞。');
  }
  if (capabilityId === 'xhs.read') {
    if (!candidate.noteId || !candidate.xsecToken) throw new Error('这条小红书笔记缺少点赞所需的标识。');
    if (String(connection.settings.mode ?? 'mcp') === 'xhs-lite') {
      await xhsLitePost(connection, 'like-feed', {
        feed_id: candidate.noteId, xsec_token: candidate.xsecToken, unlike: false,
      });
      return `点赞了《${candidate.title}》`;
    }
  }
  const initialized = await mcpRpc(connection, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'sullyos-autonomy', version: '1.0.0' },
  }, 1);
  const listed = await mcpRpc(connection, 'tools/list', {}, 2, initialized.sessionId);
  const tools = Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools as Array<Record<string, unknown>> : [];
  const toolName = capabilityId === 'x.read' ? 'x_like_tweet' : 'like_feed';
  if (!tools.some((tool) => tool.name === toolName)) throw new Error('平台桥接器尚未提供点赞动作。');
  const argumentsValue = capabilityId === 'x.read'
    ? { url: candidate.url }
    : { feed_id: candidate.noteId, xsec_token: candidate.xsecToken, unlike: false };
  const called = await mcpRpc(connection, 'tools/call', { name: toolName, arguments: argumentsValue }, 3, listed.sessionId);
  if (called.body?.error) throw new Error(bounded(called.body.error, 1_000));
  return `点赞了《${candidate.title}》`;
}

export async function performXRepost(candidate: ToolShareCandidate): Promise<string> {
  const connection = await getToolConnection('x.read');
  if (!connection?.enabled) throw new Error('X 尚未启用。');
  const initialized = await mcpRpc(connection, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'sullyos-autonomy', version: '1.0.0' },
  }, 1);
  const listed = await mcpRpc(connection, 'tools/list', {}, 2, initialized.sessionId);
  const tools = Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools as Array<Record<string, unknown>> : [];
  if (!tools.some((tool) => tool.name === 'x_repost_tweet')) throw new Error('X 桥接器尚未提供转推动作。');
  const called = await mcpRpc(connection, 'tools/call', {
    name: 'x_repost_tweet', arguments: { url: candidate.url },
  }, 3, listed.sessionId);
  if (called.body?.error) throw new Error(bounded(called.body.error, 1_000));
  return `转推了《${candidate.title}》`;
}

export async function testExternalToolConnection(connection: ToolConnection): Promise<string> {
  if (connection.id === 'phone.read') {
    const required = ['smtpHost', 'smtpUser', 'recipientEmail']
      .filter((key) => !String(connection.settings[key] ?? '').trim());
    if (!connection.credentials.smtpPassword) required.push('smtpPassword');
    if (required.length > 0) throw new Error(`手机查看还缺少：${required.join(', ')}`);
    return '邮件触发与设备令牌配置完整（未发送测试邮件）';
  }
  const mode = String(connection.settings.mode ?? 'mcp');
  if (connection.id === 'web.read') {
    const result = await runWebSearch(connection, 'OpenAI');
    return `${result.toolName} 已响应，找到 ${result.shareCandidates?.length ?? 0} 条结果`;
  }
  if (connection.id === 'mcp.read' && mode === 'mcp-pool') {
    const servers = mcpPoolServers(connection);
    if (servers.length === 0) throw new Error('还没有同步已启用且完成工具发现的 MCP 服务器。');
    let toolCount = 0;
    for (const item of servers) {
      const initialized = await mcpRpc(item.connection, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'sullyos-healthcheck', version: '1.0.0' },
      }, 1);
      const listed = await mcpRpc(item.connection, 'tools/list', {}, 2, initialized.sessionId);
      toolCount += Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools.length : 0;
    }
    if (toolCount === 0) throw new Error('MCP 服务已连接，但没有提供任何工具。');
    return `已连接 ${servers.length} 个 MCP 服务器，发现 ${toolCount} 个工具`;
  }
  if (!connection.endpoint) throw new Error('尚未填写服务地址。');
  if (connection.id === 'x.read') {
    const status = await getXSessionStatus(connection);
    if (!status.loggedIn) throw new Error('X 登录已失效，请补 Cookie 或打开远程桌面登录。');
  }
  if (connection.id === 'xhs.read' && mode === 'xhs-lite') {
    const result = await xhsLitePost(connection, 'check-login');
    const loggedIn = result?.loggedIn ?? result?.logged_in ?? result?.data?.loggedIn ?? result?.data?.logged_in;
    if (loggedIn === false) throw new Error('Cookie 已失效，请从前端重新导入。');
    return 'Cookie 登录状态正常';
  }
  if (mode === 'bridge') {
    const result = await runBridge(connection, '连接测试：只读取少量公开内容，不执行任何写操作。');
    return `${result.toolName} 已响应`;
  }
  const initialized = await mcpRpc(connection, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sullyos-healthcheck', version: '1.0.0' },
  }, 1);
  const listed = await mcpRpc(connection, 'tools/list', {}, 2, initialized.sessionId);
  const tools = Array.isArray(listed.body?.result?.tools) ? listed.body.result.tools as Array<Record<string, unknown>> : [];
  if (tools.length === 0) throw new Error('服务已连接，但没有提供任何工具。');
  return `已连接，发现 ${tools.length} 个工具`;
}

export async function executeAutonomyTool(input: {
  client: PoolClient;
  agentId: string;
  conversationId: string;
  heartbeatRunId: string;
  capabilityId: string;
  goal: string;
}): Promise<ToolRunResult> {
  if (input.capabilityId === 'phone.read') {
    const request = await createPhonePeekRequest({
      client: input.client, agentId: input.agentId, conversationId: input.conversationId,
      heartbeatRunId: input.heartbeatRunId, goal: input.goal,
    });
    return {
      status: 'planned', eventType: 'autonomous_activity', title: '想看看你正在做什么',
      toolName: 'iPhone 屏幕查看', summary: request.summary,
      metadata: { phonePeekRequestId: request.requestId },
    };
  }

  if (!['x.read', 'xhs.read', 'web.read', 'mcp.read'].includes(input.capabilityId)) {
    throw new Error(`尚未实现能力 ${input.capabilityId}。`);
  }
  const connection = await getToolConnection(input.capabilityId as 'x.read' | 'xhs.read' | 'web.read' | 'mcp.read');
  if (!connection?.enabled) throw new Error('该工具连接尚未启用。');
  const mode = String(connection.settings.mode ?? 'mcp');
  if (connection.id === 'web.read') return runWebSearch(connection, input.goal);
  if (connection.id === 'mcp.read' && mode === 'mcp-pool') return runMcpPool(connection, input.goal);
  if (!connection.endpoint) throw new Error('该工具连接没有填写服务地址。');
  if (connection.id === 'xhs.read' && mode === 'xhs-lite') return runXhsLite(connection, input.goal);
  return mode === 'bridge' ? runBridge(connection, input.goal) : runMcp(connection, input.goal);
}
