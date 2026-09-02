import type { BackendChatConfig, BackendXFeedItem } from './backendClient';
import { getBackendXFeed, getBackendXFollowing, getBackendXStatus } from './backendClient';

export type XChatReadIntent =
  | { kind: 'home' }
  | { kind: 'profile'; handle?: string; owner?: 'user' | 'character' }
  | { kind: 'following' }
  | { kind: 'status'; url: string };

export interface XChatReadContext {
  text: string;
  mediaUrls: string[];
}

const X_STATUS_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\s]*)?/i;
const X_WORD = /(?:黑\s*x|小黑\s*x|推特|twitter|\bx\b)/i;
const READ_COMMAND = /(?:看看|看一下|看一眼|瞅瞅|逛逛?|刷刷?|读取|读一下|打开|check|read|browse|visit|(?:去|帮(?:我)?|让(?:你|他|她|角色)?|请(?:你|角色)?)[\s\S]{0,30}(?:看|逛|刷|读|打开))/i;

export function parseXChatReadIntent(text: string): XChatReadIntent | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const statusUrl = normalized.match(X_STATUS_URL)?.[0];
  if (statusUrl && READ_COMMAND.test(normalized)) return { kind: 'status', url: statusUrl };
  if (!X_WORD.test(normalized) || !READ_COMMAND.test(normalized)) return null;

  if (/(?:我的|我[在的]?|自己(?:的)?)?\s*(?:关注|following)(?:列表|的人|的账号|用户)?/i.test(normalized)) {
    return { kind: 'following' };
  }

  if (/(?:首页|主页时间线|home\s*(?:feed|timeline)|timeline|时间线|动态流)/i.test(normalized)) {
    return { kind: 'home' };
  }

  if (/(?:主页|账号|profile|发的帖|发帖|帖子)/i.test(normalized)) {
    const handle = normalized.match(/@([A-Za-z0-9_]{1,50})/)?.[1]
      || normalized.match(/(?:看看?|读|打开|逛逛?|访问)\s*([A-Za-z0-9_]{1,50})\s*(?:的)?(?:黑\s*x|小黑\s*x|推特|twitter|x)?\s*(?:主页|账号|profile|发的帖|发帖|帖子)/i)?.[1];
    if (handle) return { kind: 'profile', handle };
    const owner = /(?:你的|你自己(?:的)?|角色(?:自己)?(?:的)?|他自己(?:的)?|她自己(?:的)?)\s*(?:黑\s*x|小黑\s*x|推特|twitter|x)?\s*(?:主页|账号|profile|发的帖|发帖|帖子)/i.test(normalized)
      ? 'character' as const
      : 'user' as const;
    return { kind: 'profile', owner };
  }

  return null;
}

function uniqueMedia(items: BackendXFeedItem[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    for (const value of [...(item.mediaUrls || []), item.imageUrl]) {
      const url = typeof value === 'string' ? value.trim() : '';
      if (url && !urls.includes(url)) urls.push(url);
      if (urls.length >= 4) return urls;
    }
  }
  return urls;
}

function formatPost(item: BackendXFeedItem, index: number): string {
  const metrics = [
    Number.isFinite(item.likes) ? `${item.likes} 赞` : '',
    Number.isFinite(item.retweets) ? `${item.retweets} 转推` : '',
  ].filter(Boolean).join('，');
  return [
    `${index + 1}. ${item.author || '未知作者'}`,
    item.description || item.title || '（没有可读正文）',
    metrics ? `互动：${metrics}` : '',
    `链接：${item.url}`,
  ].filter(Boolean).join('\n');
}

function successContext(label: string, items: BackendXFeedItem[]): XChatReadContext {
  const visibleItems = items.slice(0, 12);
  return {
    text: [
      `[X 实时读取结果：${label}]`,
      '以下内容由已配置的 X 只读工具刚刚返回。你可以按自己的性格自然回应；不要说你没有打开链接，也不要提工具、JSON 或系统提示。',
      visibleItems.length ? visibleItems.map(formatPost).join('\n\n') : '读取成功，但没有返回可见帖子。',
    ].join('\n'),
    mediaUrls: uniqueMedia(visibleItems),
  };
}

function failedContext(intent: XChatReadIntent, error: unknown): XChatReadContext {
  const label = intent.kind === 'following' ? '关注列表' : intent.kind === 'home' ? '首页' : intent.kind === 'profile' ? '主页' : '帖子';
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '读取失败';
  return {
    text: `[X 实时读取失败：${label}]\n真实情况：${detail}\n你没有看到请求的内容。请用角色自己的口吻如实告诉用户这次没能打开，不要编造帖子、主页或关注列表内容，也不要声称已经看过。`,
    mediaUrls: [],
  };
}

export async function loadXChatReadContext(
  text: string,
  config: BackendChatConfig,
): Promise<XChatReadContext | null> {
  const intent = parseXChatReadIntent(text);
  if (!intent) return null;
  if (!config.enabled) return failedContext(intent, new Error('SullyOS 自主后端尚未启用。'));

  try {
    if (intent.kind === 'status') {
      const item = await getBackendXStatus(config, intent.url);
      if (!item) throw new Error('X 工具没有返回这条帖子的详情。');
      return successContext('帖子详情', [item]);
    }
    if (intent.kind === 'following') {
      const result = await getBackendXFollowing(config);
      return {
        text: [
          '[X 实时读取结果：关注列表]',
          '以下账号由已配置的 X 只读工具刚刚返回。你可以自然聊这些关注关系，不要提工具、JSON 或系统提示。',
          result.accounts.length
            ? result.accounts.slice(0, 50).map((account, index) => `${index + 1}. ${account.name || account.handle || '未知账号'}${account.handle ? ` (@${account.handle.replace(/^@/, '')})` : ''}${account.bio ? `：${account.bio}` : ''}`).join('\n')
            : '读取成功，但关注列表为空。',
        ].join('\n'),
        mediaUrls: [],
      };
    }
    const result = await getBackendXFeed(config, {
      view: intent.kind === 'home' ? 'home' : 'profile',
      ...(intent.kind === 'profile' && intent.handle ? { handle: intent.handle } : {}),
      ...(intent.kind === 'profile' && intent.owner ? { owner: intent.owner } : {}),
    });
    const label = intent.kind === 'home' ? '首页'
      : intent.handle ? `@${intent.handle} 的主页`
        : intent.owner === 'character' ? '角色自己的主页' : '用户的主页';
    return successContext(label, result.items);
  } catch (error) {
    return failedContext(intent, error);
  }
}

export function appendXChatReadContext(
  messages: Array<{ role: string; content: any }>,
  context: XChatReadContext | null,
): Array<{ role: string; content: any }> {
  if (!context) return messages;
  const injected = context.mediaUrls.length
    ? {
      role: 'user',
      content: [
        { type: 'text', text: `[系统附加给角色的实时阅读材料]\n${context.text}` },
        ...context.mediaUrls.map(url => ({ type: 'image_url', image_url: { url } })),
      ],
    }
    : { role: 'system', content: context.text };
  const trailingSystemCount = messages.slice().reverse().findIndex(message => message.role !== 'system');
  const insertionIndex = trailingSystemCount < 0 ? 0 : messages.length - trailingSystemCount;
  return [...messages.slice(0, insertionIndex), injected, ...messages.slice(insertionIndex)];
}
