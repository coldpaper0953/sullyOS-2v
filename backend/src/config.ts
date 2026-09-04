import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default(
    'postgresql://sullyos:change-this-local-password@127.0.0.1:54329/sullyos',
  ),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  APP_TOKEN: z.string().min(12).default('change-this-local-token'),
  ALLOWED_ORIGINS: z.string().default(
    // 4173 = 本地静态前端（open-local-web.bat / local-static-server.cjs）。
    // 漏了它，4173 页面调 API 会被 CORS 拦（用户实测提醒过）。
    'http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173',
  ),
  // 备份文件树 + git 仓库的落盘目录。docker 里挂 bind mount 到宿主，用户可以直接看/推远端。
  BACKUP_DIR: z.string().min(1).default('./data/backup-repo'),
  MODEL_BASE_URL: z.string().default(''),
  MODEL_API_KEY: z.string().default(''),
  MODEL_NAME: z.string().default(''),
  MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.85),
  MODEL_MAX_TOKENS: z.coerce.number().int().min(1).max(128_000).default(8_000),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(300_000),
  MODEL_VAULT_KEY: z.string().default(''),
  MODEL_FAILURE_COOLDOWN_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  HEARTBEAT_POLL_MS: z.coerce.number().int().min(1000).default(30_000),
  HEARTBEAT_DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_EMAIL: z.string().default('mailto:admin@example.com'),
});

const parsed = envSchema.parse(process.env);

export const config = {
  ...parsed,
  modelVaultKey: parsed.MODEL_VAULT_KEY || parsed.APP_TOKEN,
  allowedOrigins: parsed.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
