import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebSearch } from '../src/toolRunner.js';
import type { ToolConnection } from '../src/toolConnections.js';

const connection: ToolConnection = {
  id: 'web.read',
  label: '网页探索',
  enabled: true,
  endpoint: 'https://api.search.brave.com/res/v1/web/search',
  settings: { mode: 'brave' },
  credentials: { bearerToken: 'secret' },
  lastHealthStatus: 'unknown',
  lastHealthError: null,
  lastHealthAt: null,
};

describe('web.read adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns Brave results into shareable webpage candidates', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      web: { results: [{
        title: '海洋研究',
        url: 'https://example.com/ocean',
        description: '关于海洋生态的报道。',
        profile: { long_name: 'Example' },
        thumbnail: { src: 'https://example.com/ocean.jpg' },
      }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWebSearch(connection, '海洋生态');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('q=%E6%B5%B7%E6%B4%8B%E7%94%9F%E6%80%81');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'secret' });
    expect(result.shareCandidates?.[0]).toMatchObject({
      platform: 'web',
      title: '海洋研究',
      url: 'https://example.com/ocean',
      author: 'Example',
      imageUrl: 'https://example.com/ocean.jpg',
    });
    expect(result.permissions).toEqual({ shareToChat: true, like: false, repost: false });
  });
});
