/**
 * backupRoutes.ts
 * 备份通道的 HTTP 面：全部走 api.ts 的全局 Bearer APP_TOKEN 鉴权（不在豁免名单）。
 *
 *   POST /v1/backup/upload    收前端导出的脱敏 zip → 文件树 → git commit
 *   GET  /v1/backup/status    最新提交/文件数/体积（前端启动与回前台对比用）
 *   GET  /v1/backup/history   最近提交列表（映射成 CloudBackupFile 供「云端备份」UI 复用）
 *   GET  /v1/backup/download  当前文件树重新打包 zip（自动恢复/手动恢复拉取用）
 *   DELETE /v1/backup/all     清空备份仓库（重置链路用；?keepHistory=1 保留 git 历史）
 *
 * 备份不写 PostgreSQL（pg Pool 懒连接，PG 没起也能用这条通道）。
 */

import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import {
  BackupValidationError,
  buildBackupZip,
  purgeBackupRepo,
  repoHistory,
  repoStatus,
  uploadBackupBuffer,
} from './backupRepo.js';
import { config } from './config.js';

const UPLOAD_BODY_LIMIT = 256 * 1024 * 1024;
// 每次请求时解析（而不是模块加载时固化）：单元测试会把 config.BACKUP_DIR 改指向临时目录。
const backupDir = () => path.resolve(config.BACKUP_DIR);

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  // 备份上传走整包 zip 二进制（application/zip）；Fastify 没有内置 parser 会 415。
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.post('/v1/backup/upload', { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'body 必须是 zip 二进制' });
    }
    try {
      const result = await uploadBackupBuffer(backupDir(), body);
      app.log.info(
        { committed: result.committed, commit: result.commit, files: result.fileCount, bytes: body.length },
        'backup uploaded',
      );
      return reply.code(200).send({ data: result });
    } catch (error) {
      if (error instanceof BackupValidationError) {
        app.log.warn({ problems: error.problems }, 'backup rejected');
        return reply.code(400).send({ error: 'backup_rejected', message: error.message, details: error.problems });
      }
      throw error;
    }
  });

  app.get('/v1/backup/status', async () => {
    const status = await repoStatus(backupDir());
    return { data: status };
  });

  app.get('/v1/backup/history', async (request) => {
    const limit = Math.min(Math.max(Number((request.query as { limit?: string }).limit) || 10, 1), 100);
    const commits = await repoHistory(backupDir(), limit);
    const status = await repoStatus(backupDir());
    // CloudBackupFile 形态：name 供 UI 展示、href 存 commit hash、size 用当前树体积。
    return {
      data: commits.map((c) => ({
        name: `${c.message} (${c.hash.slice(0, 8)})`,
        size: status.sizeBytes,
        lastModified: c.time,
        href: c.hash,
        status: 'ready' as const,
      })),
    };
  });

  app.get('/v1/backup/download', async (_request, reply) => {
    try {
      const zip = await buildBackupZip(backupDir());
      return reply
        .code(200)
        .header('content-type', 'application/zip')
        .header('content-length', zip.length)
        .send(zip);
    } catch (error) {
      if (error instanceof BackupValidationError) {
        return reply.code(404).send({ error: 'no_backup', message: error.message });
      }
      throw error;
    }
  });

  // 重置用：清空备份仓库的全部内容（工作树 + git 历史），仓库目录保留、
  // 回到「空仓库」状态。带 ?keepHistory=1 只清当前文件树、保留 git 历史。
  app.delete('/v1/backup/all', async (request) => {
    const keepHistory = (request.query as { keepHistory?: string }).keepHistory === '1';
    const result = await purgeBackupRepo(backupDir(), { keepHistory });
    app.log.info({ ...result }, 'backup repo purged');
    return { data: result };
  });
}
