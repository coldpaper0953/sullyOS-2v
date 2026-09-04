import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerBackupRoutes } from '../src/backupRoutes.js';
import { config } from '../src/config.js';

// git 探测与 backupRepo 同源：认 SULLY_GIT_BIN（Windows 上 git 常不在 node 的 PATH 里），否则裸 git
const GIT_BIN = process.env.SULLY_GIT_BIN || 'git';
const gitAvailable = await new Promise<boolean>((resolve) => {
  execFile(GIT_BIN, ['--version'], (err) => resolve(!err));
});

function buildZip(entries: Record<string, unknown | Uint8Array>): Buffer {
  const input: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    input[name] = value instanceof Uint8Array ? value
      : new TextEncoder().encode(JSON.stringify(value));
  }
  return Buffer.from(zipSync(input, { level: 6 }));
}

/** 最小合法脱敏备份包：manifest + metadata + 一个 store 分片 + 一个二进制。 */
const validBackup = () => buildZip({
  'manifest.json': { formatVersion: 3, mode: 'text_only', createdAt: 1788500000000, stores: { messages: { parts: 1, count: 1 } } },
  'metadata.json': { version: 'test', apiConfig: { apiKey: '', baseUrl: 'https://x' } },
  'stores/messages.000.json': [{ id: 'm1', content: 'hello' }],
  'stores/memory_vectors.bin': new Uint8Array([1, 2, 3, 4]),
});

describe.skipIf(!gitAvailable)('备份仓库通道 /v1/backup/*（真 git + 临时目录）', () => {
  let app: FastifyInstance;
  let dir: string;
  const token = config.APP_TOKEN;
  const auth = { authorization: `Bearer ${token}` };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sully-backup-test-'));
    // config 在模块加载时解析成常量对象；把备份目录指到临时目录再注册路由
    (config as { BACKUP_DIR: string }).BACKUP_DIR = dir;
    app = Fastify({ logger: false });
    // 复刻 api.ts 的全局 Bearer 鉴权钩子（豁免名单里没有备份路由）
    app.addHook('onRequest', async (request, reply) => {
      const p = request.url.split('?', 1)[0];
      if (p === '/health') return;
      if (request.headers.authorization !== `Bearer ${token}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
    await registerBackupRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('无鉴权 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/backup/status' });
    expect(res.statusCode).toBe(401);
  });

  it('上传 → 文件树落盘 + git commit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/backup/upload',
      headers: { ...auth, 'content-type': 'application/zip' },
      payload: validBackup(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.committed).toBe(true);
    expect(body.data.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.data.fileCount).toBe(4);
    // 宿主侧真实文件树
    expect(await fs.readFile(path.join(dir, 'stores', 'messages.000.json'), 'utf8')).toContain('m1');
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.formatVersion).toBe(3);
  });

  it('内容没变再上传 → committed:false（不产生空 commit）', async () => {
    // 前一个测试已上传过同样内容——不假设这次会不会产生新提交，只验证：
    // 连续两次上传后 commit 不再前进（第二次必然 committed:false 且 hash 不变）。
    const first = (await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: validBackup(),
    })).json().data;
    expect(first.commit).toBeTruthy();
    const second = (await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: validBackup(),
    })).json().data;
    expect(second.committed).toBe(false);
    expect(second.commit).toBe(first.commit);
  });

  it('旧分片在新备份里消失 → 从文件树删掉（git 可 diff 出删除）', async () => {
    await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: buildZip({
        'manifest.json': { formatVersion: 3, mode: 'text_only', stores: { messages: { parts: 2, count: 2 } } },
        'metadata.json': { version: 'test' },
        'stores/messages.000.json': [{ id: 'm1' }],
        'stores/messages.001.json': [{ id: 'm2' }],
      }),
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: buildZip({
        'manifest.json': { formatVersion: 3, mode: 'text_only', stores: { messages: { parts: 1, count: 1 } } },
        'metadata.json': { version: 'test' },
        'stores/messages.000.json': [{ id: 'm1' }],
      }),
    });
    expect(res.json().data.committed).toBe(true);
    await expect(fs.stat(path.join(dir, 'stores', 'messages.001.json'))).rejects.toThrow();
  });

  it('包里字段名是密钥样式且带非空值 → 400 拒收', async () => {
    const bad = buildZip({
      'manifest.json': { formatVersion: 3, mode: 'text_only', stores: {} },
      'metadata.json': { apiConfig: { apiKey: 'sk-realtoken123', baseUrl: '' } },
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('backup_rejected');
  });

  it('metadata.json 正文含 ghp_ 形态凭据 → 400 拒收', async () => {
    const bad = buildZip({
      'manifest.json': { formatVersion: 3, mode: 'text_only', stores: {} },
      'metadata.json': { note: 'ghp_Abcdefghijklmnopqrstuvwxyz1234' },
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: bad,
    });
    expect(res.statusCode).toBe(400);
  });

  it('zip-slip 路径 → 400 拒收', async () => {
    const bad = buildZip({
      '../evil.json': { x: 1 },
      'manifest.json': { formatVersion: 3, mode: 'text_only', stores: {} },
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: bad,
    });
    expect(res.statusCode).toBe(400);
  });

  it('脱敏正确（密钥字段=空串）→ 通过；聊天正文不误伤', async () => {
    const ok = buildZip({
      'manifest.json': { formatVersion: 3, mode: 'text_only', stores: { messages: { parts: 1, count: 1 } } },
      'metadata.json': { apiConfig: { apiKey: '', baseUrl: 'https://x' }, pushVapid: { vapidPrivateKey: '' } },
      // 聊天正文里出现"password"字样是用户内容，只在字段名上扫 → 不拦
      'stores/messages.000.json': [{ id: 'm1', content: '他跟我说他的 password 是秘密' }],
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: ok,
    });
    expect(res.statusCode).toBe(200);
  });

  it('status / history / download 三件套', async () => {
    const status = (await app.inject({ method: 'GET', url: '/v1/backup/status', headers: auth })).json().data;
    expect(status.exists).toBe(true);
    expect(status.latestCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(status.commitTime).toBeTruthy();
    expect(status.fileCount).toBeGreaterThan(0);

    const history = (await app.inject({ method: 'GET', url: '/v1/backup/history', headers: auth })).json().data;
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].status).toBe('ready');
    expect(history[0].href).toMatch(/^[0-9a-f]{40}$/);

    const dl = await app.inject({ method: 'GET', url: '/v1/backup/download', headers: auth });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    // 下载回来的 zip 能解开且包含 manifest 与分片
    const entries = unzipSync(new Uint8Array(dl.rawPayload));
    expect(Object.keys(entries)).toContain('manifest.json');
    expect(Object.keys(entries)).toContain('stores/messages.000.json');
  });

  it('真实前端导出的 zip 带目录条目（stores/、assets/）→ 放行且不落盘（E2E 抓到过的误杀）', async () => {
    const zip = buildZip({
      'manifest.json': { formatVersion: 3, mode: 'text_only', stores: { messages: { parts: 1, count: 1 } } },
      'metadata.json': { version: 'test' },
      'stores/': new Uint8Array(0),
      'assets/': new Uint8Array(0),
      'stores/messages.000.json': [{ id: 'm1', content: 'hi' }],
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: zip,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.fileCount).toBe(3); // 目录条目不算文件
    // 目录条目没有变成名字叫 "stores" 的空文件
    const st = await fs.stat(path.join(dir, 'stores'));
    expect(st.isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(dir, 'assets'))).rejects.toThrow();
  });

  it('空 body → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /v1/backup/all → 文件树+git 历史全清、仓库重建为空（重置链路）', async () => {
    // 先传一份，保证有东西可清
    await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: validBackup(),
    });
    const before = (await app.inject({ method: 'GET', url: '/v1/backup/status', headers: auth })).json().data;
    expect(before.exists).toBe(true);

    const res = await app.inject({ method: 'DELETE', url: '/v1/backup/all', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.historyWiped).toBe(true);

    // 仓库回到「空仓库」状态：无提交、无文件
    const status = (await app.inject({ method: 'GET', url: '/v1/backup/status', headers: auth })).json().data;
    expect(status.exists).toBe(true);
    expect(status.latestCommit).toBeNull();
    expect(status.fileCount).toBe(0);
    expect(status.sizeBytes).toBe(0);

    // history 空；download 404
    const history = (await app.inject({ method: 'GET', url: '/v1/backup/history', headers: auth })).json().data;
    expect(history).toHaveLength(0);
    const dl = await app.inject({ method: 'GET', url: '/v1/backup/download', headers: auth });
    expect(dl.statusCode).toBe(404);

    // 清完还能继续收新备份（仓库可用性不破）
    const up = await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: validBackup(),
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().data.committed).toBe(true);
  });

  it('DELETE /v1/backup/all?keepHistory=1 → 只清工作树、旧提交还挂在 git 历史里', async () => {
    await app.inject({
      method: 'POST', url: '/v1/backup/upload', headers: { ...auth, 'content-type': 'application/zip' }, payload: validBackup(),
    });
    const res = await app.inject({ method: 'DELETE', url: '/v1/backup/all?keepHistory=1', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.historyWiped).toBe(false);

    const history = (await app.inject({ method: 'GET', url: '/v1/backup/history', headers: auth })).json().data;
    // 旧 commit + 空树 commit 至少两跳历史在
    expect(history.length).toBeGreaterThanOrEqual(2);
    const status = (await app.inject({ method: 'GET', url: '/v1/backup/status', headers: auth })).json().data;
    expect(status.fileCount).toBe(0);
    expect(status.sizeBytes).toBe(0);
  });
});
