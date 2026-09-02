import { describe, expect, it } from 'vitest';
import { chooseXReadTool, extractXFollowingAccounts, extractXShareCandidates, extractXhsShareCandidates, matchingXStatus, xStatusToolArguments } from '../src/toolRunner.js';

describe('platform share candidates', () => {
  it('uses the exact single-post argument required by the deployed X MCP', () => {
    expect(xStatusToolArguments({
      inputSchema: { properties: { url_or_id: { type: 'string' } } },
    }, 'https://x.com/shark/status/123')).toEqual({ url_or_id: 'https://x.com/shark/status/123' });
  });
  it('extracts an X status as a shareable card candidate', () => {
    const [candidate] = extractXShareCandidates({
      data: [{
        tweet_url: 'https://x.com/shark/status/1234567890',
        text: '今天在海边捡到一块很漂亮的玻璃。',
        handle: 'shark',
        image_url: 'https://img.example/x.jpg',
        like_count: 42,
        retweet_count: 7,
      }],
    });

    expect(candidate).toMatchObject({
      platform: 'x',
      url: 'https://x.com/shark/status/1234567890',
      title: '今天在海边捡到一块很漂亮的玻璃。',
      author: '@shark',
      imageUrl: 'https://img.example/x.jpg',
      likes: 42,
      retweets: 7,
    });
  });

  it('keeps Xiaohongshu candidates on their dedicated card path', () => {
    const [candidate] = extractXhsShareCandidates({
      noteCard: {
        note_id: '0123456789abcdef01234567',
        title: '海边散步',
        desc: '风很轻。',
        user: { nickname: '小鲨鱼' },
      },
      xsec_token: 'token',
    });

    expect(candidate).toMatchObject({
      platform: 'xhs',
      noteId: '0123456789abcdef01234567',
      title: '海边散步',
      author: '小鲨鱼',
    });
  });

  it('reads text, media and metrics from nested X payloads', () => {
    const [candidate] = extractXShareCandidates({
      data: [{
        url: 'https://x.com/waffle/status/9876543210',
        full_text: '华夫饼边缘要烤到刚好发脆。',
        user: { screen_name: 'waffle', name: '华夫饼研究所' },
        attachments: { media: [{ preview_image_url: 'https://img.example/waffle.jpg' }] },
        public_metrics: { like_count: 12003, retweet_count: 876 },
      }],
    });

    expect(candidate).toMatchObject({
      description: '华夫饼边缘要烤到刚好发脆。',
      author: '@waffle',
      imageUrl: 'https://img.example/waffle.jpg',
      likes: 12003,
      retweets: 876,
    });
  });

  it('deduplicates X media, caps it at four, and ignores reply media', () => {
    const [candidate] = extractXShareCandidates({
      url: 'https://x.com/waffle/status/9876543210',
      focused: {
        id: '9876543210',
        url: 'https://x.com/waffle/status/9876543210',
        text: 'A gallery',
        attachments: {
          media: [
            { media_url: 'https://img.example/1.jpg' },
            { preview_image_url: 'https://img.example/2.jpg' },
            { image_url: 'https://img.example/1.jpg' },
            { url: 'https://img.example/3.jpg' },
            { thumbnail_url: 'https://img.example/4.jpg' },
            { image: 'https://img.example/5.jpg' },
          ],
        },
      },
      replies: [{
        id: '9876543211',
        url: 'https://x.com/reply/status/9876543211',
        image_url: 'https://img.example/reply.jpg',
      }],
    });

    expect(candidate?.mediaUrls).toEqual([
      'https://img.example/1.jpg',
      'https://img.example/2.jpg',
      'https://img.example/3.jpg',
      'https://img.example/4.jpg',
    ]);
    expect(candidate?.imageUrl).toBe('https://img.example/1.jpg');
  });

  it('extracts the focused post from the deployed x_read_tweet response shape', () => {
    const [candidate] = extractXShareCandidates({
      url: 'https://x.com/yongsa412/status/2087158741556928724',
      focused: {
        id: '2087158741556928724',
        url: 'https://x.com/yongsa412/status/2087158741556928724',
        text: 'Small Fun', author: '勇士', handle: 'yongsa412',
        reply_count: 9, retweet_count: 428, like_count: 71,
      },
      parents: [],
      replies: [{
        id: '2087419064453132644', url: 'https://x.com/AlexBlazan/status/2087419064453132644',
        text: 'A reply', author: 'Alex', handle: 'AlexBlazan', like_count: 0, retweet_count: 0,
      }],
    });
    expect(candidate).toMatchObject({
      url: 'https://x.com/yongsa412/status/2087158741556928724',
      title: 'Small Fun', description: 'Small Fun', author: '@yongsa412', likes: 71, retweets: 428,
    });
  });

  it('only enriches media from the exact X status id', () => {
    const candidates = [
      { platform: 'x' as const, url: 'https://x.com/shark/status/111', title: 'other', imageUrl: 'https://img.example/wrong.jpg' },
      { platform: 'x' as const, url: 'https://twitter.com/shark/status/222', title: 'target', imageUrl: 'https://img.example/right.jpg' },
    ];

    expect(matchingXStatus(candidates, 'https://x.com/shark/status/222')?.imageUrl)
      .toBe('https://img.example/right.jpg');
    expect(matchingXStatus(candidates, 'https://x.com/shark/status/333')).toBeNull();
  });

  it('normalizes and deduplicates X following accounts', () => {
    expect(extractXFollowingAccounts({ users: [
      { screen_name: 'shark', name: '小鲨鱼', description: '海边散步。' },
      { username: '@waffle', display_name: '华夫饼' },
      { handle: 'SHARK', name: '重复项' },
    ] })).toEqual([
      { handle: 'shark', name: '小鲨鱼', bio: '海边散步。' },
      { handle: 'waffle', name: '华夫饼', bio: '' },
    ]);
  });

  it('does not disguise the home feed as the requested own profile', () => {
    const connection = { settings: {} } as any;
    const tools = [{ name: 'x_read_home' }, { name: 'x_read_timeline' }];
    expect(() => chooseXReadTool(connection, '我的主页', tools))
      .toThrow('没有保存你的账号 handle');
    expect(() => chooseXReadTool(connection, '主页: shark', [{ name: 'x_read_home' }]))
      .toThrow('没有提供用户主页读取工具');
  });
});
