/**
 * backupRepo.ts
 * 「前端导出的脱敏 zip → JSON 文件树 → 自动 git commit」的纯逻辑层。
 *
 * 用户定调（2026-09-04）：密钥只走 sully_settings 逐键加密同步，**永远不进 git 仓库**；
 * 其他所有数据（角色/聊天/帖子/记忆/向量）以 git 可 diff 的文件树形式落盘，历史即备份。
 *
 * 这里在服务端再守一道红线：写入文件树前扫描结构化 JSON——任何「密钥样式字段名带非空值」
 * 直接拒收（400），防止前端剥离逻辑哪天回归把真实密钥带进仓库。只按字段名扫、不扫
 * 正文长串：用户聊天里粘过密钥是用户自己的内容，不能因此打断整条备份链。
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';

/** 前端 deepStripSecrets 同款字段名规则——这些字段在脱敏备份里必须是空串。 */
const SECRET_FIELD_RE =
  /api[-_]?key|apikey|token|secret|password|passphrase|private[-_]?key|shared[-_]?key|authorization|auth[-_]?header|bearer|-auth$/i;
/** metadata.json（设置区，体积小）额外做凭据值扫描；stores 聊天正文不扫，避免误伤用户内容。 */
const CREDENTIAL_VALUE_RE = /sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

export class BackupValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`备份内容未通过校验: ${problems.join('; ')}`);
    this.name = 'BackupValidationError';
  }
}

/** zip-slip 防护：拒绝绝对路径、盘符、反斜杠、`..` 段与空段。目录条目（末尾 /）放行，由写树时跳过。 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  const isDir = name.endsWith('/');
  const parts = name.split('/');
  // 目录条目形如 "stores/"，split 后末尾是空段——只允许末尾这一个空段
  if (isDir) parts.pop();
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '..');
}

/** 递归扫结构化 JSON：密钥样式字段名带非空字符串值 = 问题。数组里逐项下钻。 */
function findSecretFields(value: unknown, where: string, problems: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findSecretFields(item, `${where}[${i}]`, problems));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_RE.test(key) && typeof child === 'string' && child.trim()) {
      problems.push(`${where}.${key} 带非空值（脱敏备份里应为空串）`);
    } else {
      findSecretFields(child, `${where}.${key}`, problems);
    }
  }
}

const isTreeJson = (name: string): boolean =>
  (name === 'manifest.json' || name === 'metadata.json' || name.startsWith('stores/')) && name.endsWith('.json');

/** 校验解包后的条目：manifest 契约 + 路径安全 + 密钥红线。全部通过才允许落盘。 */
export function validateBackupEntries(entries: Record<string, Uint8Array>): void {
  const problems: string[] = [];
  for (const name of Object.keys(entries)) {
    if (!isSafeEntryName(name)) problems.push(`不安全的包内路径: ${name}`);
  }

  const manifestRaw = entries['manifest.json'];
  if (!manifestRaw) throw new BackupValidationError(['包里没有 manifest.json']);
  let manifest: { formatVersion?: number; mode?: string };
  try {
    manifest = JSON.parse(Buffer.from(manifestRaw).toString('utf8'));
  } catch {
    throw new BackupValidationError(['manifest.json 不是合法 JSON']);
  }
  if (manifest.formatVersion !== 2 && manifest.formatVersion !== 3) {
    problems.push(`manifest.formatVersion=${String(manifest.formatVersion)} 不在支持范围（2/3）`);
  }
  if (!manifest.mode) problems.push('manifest.mode 缺失');

  for (const [name, bytes] of Object.entries(entries)) {
    if (!isTreeJson(name)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      problems.push(`${name} 不是合法 JSON`);
      continue;
    }
    findSecretFields(parsed, name, problems);
    if (name === 'metadata.json') {
      const text = Buffer.from(bytes).toString('utf8');
      const hit = text.match(CREDENTIAL_VALUE_RE);
      if (hit) problems.push(`metadata.json 疑似含明文凭据: ${hit[0].slice(0, 8)}…`);
    }
  }

  if (problems.length > 0) throw new BackupValidationError(problems);
}

/** 把 zip 条目写成文件树；旧备份里已不存在这次条目之外的文件先删掉（.git 绝不碰）。 */
export async function writeBackupTree(
  backupDir: string,
  entries: Record<string, Uint8Array>,
): Promise<number> {
  const walk = async (dir: string, base = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (base === '' && entry.name === '.git') continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
      else out.push(rel);
    }
    return out;
  };

  const existing = await walk(backupDir).catch(() => [] as string[]);
  // 目录条目（末尾 /）不落盘也不算文件数；existing walk 只出文件，对齐口径
  const wanted = new Set(Object.keys(entries).filter((name) => !name.endsWith('/')));
  for (const stale of existing) {
    if (!wanted.has(stale)) await fs.rm(path.join(backupDir, ...stale.split('/')), { force: true });
  }

  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    const target = path.join(backupDir, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  return wanted.size;
}

// ─── git 操作（execFile，绝不走 shell，参数注入免疫）──────────────────

const GIT_BIN = process.env.SULLY_GIT_BIN || 'git';
const GIT_IDENTITY_NAME = 'SullyOS Backup';
const GIT_IDENTITY_EMAIL = 'backup@sullyos.local';

function git(backupDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // 身份走进程 env 注入而不是仓库 config：docker 里容器重建后 BACKUP_DIR 的 bind mount
    // 可换宿主路径，config user.email 写进仓库里的 .git/config 跟着走没必要；env 无脑生效。
    // 同时覆盖 author/committer——Windows 上宿主可能没配全局身份，git commit 会拒绝。
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: GIT_IDENTITY_NAME,
      GIT_AUTHOR_EMAIL: GIT_IDENTITY_EMAIL,
      GIT_COMMITTER_NAME: GIT_IDENTITY_NAME,
      GIT_COMMITTER_EMAIL: GIT_IDENTITY_EMAIL,
    };
    execFile(GIT_BIN, args, { cwd: backupDir, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        (err as NodeJS.ErrnoException).message += ` (git ${args.join(' ')}): ${String(stderr).slice(0, 300)}`;
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

async function headHash(backupDir: string): Promise<string | null> {
  try {
    return (await git(backupDir, ['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

/** 仓库不存在则 init；身份走 env（见 git()），不动全局/仓库 config。 */
export async function ensureGitRepo(backupDir: string): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true });
  const gitDir = path.join(backupDir, '.git');
  if (await fs.stat(gitDir).then(() => true).catch(() => false)) return;
  try {
    await git(backupDir, ['init', '-b', 'main']);
  } catch {
    await git(backupDir, ['init']);
  }
}

export interface CommitResult {
  committed: boolean;
  commit: string | null;
  message: string;
  fileCount: number;
  sizeBytes: number;
}

export async function commitBackupTree(backupDir: string, at: Date = new Date()): Promise<CommitResult> {
  await ensureGitRepo(backupDir);
  await git(backupDir, ['add', '-A']);
  const status = await git(backupDir, ['status', '--porcelain']);
  const fileCount = (await git(backupDir, ['ls-files'])).split('\n').filter(Boolean).length;

  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const message = `backup ${stamp}`;

  if (!status.trim()) {
    return { committed: false, commit: await headHash(backupDir), message, fileCount, sizeBytes: await treeSize(backupDir) };
  }
  await git(backupDir, ['commit', '-m', message]);
  return { committed: true, commit: await headHash(backupDir), message, fileCount, sizeBytes: await treeSize(backupDir) };
}

async function treeSize(backupDir: string): Promise<number> {
  const walk = async (dir: string, base = ''): Promise<number> => {
    let total = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (base === '' && entry.name === '.git') continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) total += await walk(path.join(dir, entry.name), rel);
      else total += await fs.stat(path.join(dir, entry.name)).then((s) => s.size).catch(() => 0);
    }
    return total;
  };
  return walk(backupDir);
}

export interface RepoStatus {
  exists: boolean;
  latestCommit: string | null;
  commitTime: string | null;
  fileCount: number;
  sizeBytes: number;
}

export async function repoStatus(backupDir: string): Promise<RepoStatus> {
  const gitDir = path.join(backupDir, '.git');
  if (!(await fs.stat(gitDir).then(() => true).catch(() => false))) {
    return { exists: false, latestCommit: null, commitTime: null, fileCount: 0, sizeBytes: 0 };
  }
  const latestCommit = await headHash(backupDir);
  let commitTime: string | null = null;
  if (latestCommit) {
    commitTime = (await git(backupDir, ['log', '-1', '--format=%cI'])).trim() || null;
  }
  const fileCount = (await git(backupDir, ['ls-files']).catch(() => ''))!.split('\n').filter(Boolean).length;
  return { exists: true, latestCommit, commitTime, fileCount, sizeBytes: await treeSize(backupDir) };
}

export interface CommitInfo {
  hash: string;
  time: string;
  message: string;
}

export async function repoHistory(backupDir: string, limit = 10): Promise<CommitInfo[]> {
  const gitDir = path.join(backupDir, '.git');
  if (!(await fs.stat(gitDir).then(() => true).catch(() => false))) return [];
  const out = await git(backupDir, [
    'log', `-n${Math.min(Math.max(limit, 1), 100)}`, '--format=%H%x1f%cI%x1f%s',
  ]).catch(() => '');
  return out!.split('\n').filter(Boolean).map((line) => {
    const [hash, time, ...rest] = line.split('\x1f');
    return { hash: hash || '', time: time || '', message: rest.join('\x1f') };
  }).filter((c) => c.hash);
}

/** 从当前文件树重新打包 zip（.bin 等二进制 STORE 不压缩，json 压缩）。 */
export async function buildBackupZip(backupDir: string): Promise<Buffer> {
  const walk = async (dir: string, base = ''): Promise<Array<[string, Buffer]>> => {
    const out: Array<[string, Buffer]> = [];
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (base === '' && entry.name === '.git') continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
      else out.push([rel, await fs.readFile(path.join(dir, entry.name))]);
    }
    return out;
  };
  const files = await walk(backupDir);
  if (files.length === 0) throw new BackupValidationError(['备份仓库是空的，先上传一次']);
  const zipInput: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, buf] of files) {
    const level: 0 | 6 = /\.(bin|zip|png|jpe?g|webp|gif|woff2?)$/i.test(name) ? 0 : 6;
    zipInput[name] = [new Uint8Array(buf), { level }];
  }
  return Buffer.from(zipSync(zipInput));
}

/** 主入口：接收脱敏 zip → 校验 → 落盘 → git commit。 */
export async function uploadBackupBuffer(
  backupDir: string,
  zipBuffer: Buffer,
  at: Date = new Date(),
): Promise<CommitResult & { problems?: never }> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch (error) {
    throw new BackupValidationError([`zip 解包失败: ${(error as Error).message}`]);
  }
  validateBackupEntries(entries);
  const fileCount = await writeBackupTree(backupDir, entries);
  const commit = await commitBackupTree(backupDir, at);
  return { ...commit, fileCount };
}

export interface PurgeResult {
  /** 是否清掉了 git 历史（keepHistory=1 或仓库本来为空时为 false） */
  historyWiped: boolean;
  /** 清掉的文件树字节数（purge 前的 treeSize） */
  removedBytes: number;
}

/**
 * 清空备份仓库：默认工作树 + .git 全删后重建空仓库（历史不可恢复）；
 * keepHistory=true 只把工作树清到空提交（旧历史还挂在 git 里）。
 * 重置链路（前端「格式化系统」勾选「连备份一起清」）走默认全清。
 */
export async function purgeBackupRepo(
  backupDir: string,
  options: { keepHistory?: boolean } = {},
): Promise<PurgeResult> {
  const existed = await fs.stat(backupDir).then(() => true).catch(() => false);
  const removedBytes = existed ? await treeSize(backupDir) : 0;

  if (options.keepHistory) {
    if (!existed) return { historyWiped: false, removedBytes };
    await ensureGitRepo(backupDir);
    // 只清工作树：删掉 .git 之外的条目，提交一个空树
    for (const entry of await fs.readdir(backupDir)) {
      if (entry === '.git') continue;
      await fs.rm(path.join(backupDir, entry), { recursive: true, force: true });
    }
    await commitBackupTree(backupDir, new Date(0));
    return { historyWiped: false, removedBytes };
  }

  // 全清：整个目录（含 .git）删掉重建空仓库
  if (existed) await fs.rm(backupDir, { recursive: true, force: true });
  await ensureGitRepo(backupDir);
  return { historyWiped: true, removedBytes };
}
