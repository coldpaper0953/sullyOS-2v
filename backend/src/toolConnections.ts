import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAPABILITY_REGISTRY } from './capabilities.js';
import { pool } from './db.js';
import { decryptSecret, encryptSecret } from './modelVault.js';

export type ToolConnectionId = 'x.read' | 'xhs.read' | 'web.read' | 'mcp.read' | 'phone.read';

export interface ToolConnection {
  id: ToolConnectionId;
  label: string;
  enabled: boolean;
  endpoint: string;
  settings: Record<string, unknown>;
  credentials: Record<string, string>;
  lastHealthStatus: string;
  lastHealthError: string | null;
  lastHealthAt: Date | null;
}

const connectionIdSchema = z.enum(['x.read', 'xhs.read', 'web.read', 'mcp.read', 'phone.read']);
const patchSchema = z.object({
  label: z.string().max(100).default(''),
  enabled: z.boolean(),
  endpoint: z.string().max(2_000).default(''),
  settings: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string().max(20_000)).default({}),
});
const xSessionSchema = z.object({
  authToken: z.string().min(10).max(1_000),
  ct0: z.string().max(1_000).optional().default(''),
});
const xFeedSchema = z.object({
  view: z.enum(['home', 'notifications', 'profile']).default('home'),
  handle: z.string().max(100).optional(),
  owner: z.enum(['user', 'character']).optional(),
});

interface ConnectionRow {
  id: ToolConnectionId;
  label: string;
  enabled: boolean;
  endpoint: string;
  settings: Record<string, unknown>;
  credentials_ciphertext: string | null;
  last_health_status: string;
  last_health_error: string | null;
  last_health_at: Date | null;
}

function decryptCredentials(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(decryptSecret(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )));
  } catch {
    return {};
  }
}

function fromRow(row: ConnectionRow): ToolConnection {
  return {
    id: row.id,
    label: row.label,
    enabled: row.enabled,
    endpoint: row.endpoint,
    settings: row.settings || {},
    credentials: decryptCredentials(row.credentials_ciphertext),
    lastHealthStatus: row.last_health_status,
    lastHealthError: row.last_health_error,
    lastHealthAt: row.last_health_at,
  };
}

function publicConnection(connection: ToolConnection) {
  return {
    id: connection.id,
    label: connection.label,
    enabled: connection.enabled,
    endpoint: connection.endpoint,
    settings: connection.settings,
    secretKeys: Object.keys(connection.credentials),
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthError: connection.lastHealthError,
    lastHealthAt: connection.lastHealthAt?.toISOString() ?? null,
  };
}

export async function getToolConnection(id: ToolConnectionId): Promise<ToolConnection | null> {
  const result = await pool.query<ConnectionRow>(
    `SELECT id, label, enabled, endpoint, settings, credentials_ciphertext,
            last_health_status, last_health_error, last_health_at
     FROM external_tool_connections WHERE id=$1`,
    [id],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function listToolConnections(): Promise<ToolConnection[]> {
  const result = await pool.query<ConnectionRow>(
    `SELECT id, label, enabled, endpoint, settings, credentials_ciphertext,
            last_health_status, last_health_error, last_health_at
     FROM external_tool_connections ORDER BY id`,
  );
  return result.rows.map(fromRow);
}

export async function connectedCapabilityIds(): Promise<Set<string>> {
  const connections = await listToolConnections();
  return new Set(connections.filter((item) => item.enabled).map((item) => item.id));
}

async function saveHealth(id: ToolConnectionId, status: 'healthy' | 'unhealthy', error: string | null): Promise<void> {
  await pool.query(
    `UPDATE external_tool_connections
     SET last_health_status=$2, last_health_error=$3, last_health_at=now(), updated_at=now()
     WHERE id=$1`,
    [id, status, error],
  );
}

export async function registerToolConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/tools', async () => ({
    data: {
      connections: (await listToolConnections()).map(publicConnection),
      capabilities: CAPABILITY_REGISTRY,
    },
  }));

  app.get('/v1/tools/x.read/session', async (request, reply) => {
    const connection = await getToolConnection('x.read');
    if (!connection?.enabled || !connection.endpoint) {
      return reply.code(400).send({ error: { code: 'x_not_configured', message: 'X 工具尚未启用。' } });
    }
    const { getXSessionStatus } = await import('./toolRunner.js');
    return { data: await getXSessionStatus(connection) };
  });

  app.post('/v1/tools/x.read/session', async (request, reply) => {
    const input = xSessionSchema.parse(request.body);
    const connection = await getToolConnection('x.read');
    if (!connection?.enabled || !connection.endpoint) {
      return reply.code(400).send({ error: { code: 'x_not_configured', message: 'X 工具尚未启用。' } });
    }
    const { updateXSessionCookies } = await import('./toolRunner.js');
    const status = await updateXSessionCookies(connection, input);
    await saveHealth('x.read', status.loggedIn ? 'healthy' : 'unhealthy', status.loggedIn ? null : 'X 登录仍未生效');
    return { data: status };
  });

  app.post('/v1/tools/x.read/feed', async (request, reply) => {
    const input = xFeedSchema.parse(request.body ?? {});
    const connection = await getToolConnection('x.read');
    if (!connection?.enabled || !connection.endpoint) return reply.code(400).send({ error: { code: 'x_not_configured', message: 'X 工具尚未启用' } });
    try {
      const { readXFeed } = await import('./toolRunner.js');
      return { data: await readXFeed(input) };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'x_feed_failed', message: error instanceof Error ? error.message : 'X Feed 读取失败' } });
    }
  });

  app.post('/v1/tools/x.read/following', async (_request, reply) => {
    const connection = await getToolConnection('x.read');
    if (!connection?.enabled || !connection.endpoint) return reply.code(400).send({ error: { code: 'x_not_configured', message: 'X 工具尚未启用' } });
    try {
      const { readXFollowing } = await import('./toolRunner.js');
      return { data: await readXFollowing() };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'x_following_failed', message: error instanceof Error ? error.message : 'X 关注列表读取失败' } });
    }
  });

  app.post('/v1/tools/x.read/status', async (request, reply) => {
    const input = z.object({ url: z.string().url().max(2_000) }).parse(request.body ?? {});
    const connection = await getToolConnection('x.read');
    if (!connection?.enabled || !connection.endpoint) return reply.code(400).send({ error: { code: 'x_not_configured', message: 'X 工具尚未启用' } });
    try {
      const { readXStatus } = await import('./toolRunner.js');
      return { data: await readXStatus(input.url) };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'x_status_failed', message: error instanceof Error ? error.message : 'X 帖子读取失败' } });
    }
  });

  app.put('/v1/tools/:id', async (request) => {
    const id = connectionIdSchema.parse((request.params as { id?: unknown }).id);
    const input = patchSchema.parse(request.body);
    const existing = await getToolConnection(id);
    const credentials = { ...(existing?.credentials ?? {}) };
    for (const [key, value] of Object.entries(input.secrets)) {
      if (value) credentials[key] = value;
      else delete credentials[key];
    }
    let generatedDeviceToken: string | undefined;
    if (id === 'phone.read' && !credentials.deviceToken) {
      generatedDeviceToken = randomBytes(24).toString('base64url');
      credentials.deviceToken = generatedDeviceToken;
    }
    await pool.query(
      `INSERT INTO external_tool_connections
         (id, label, enabled, endpoint, settings, credentials_ciphertext, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())
       ON CONFLICT (id) DO UPDATE SET
         label=EXCLUDED.label, enabled=EXCLUDED.enabled, endpoint=EXCLUDED.endpoint,
         settings=EXCLUDED.settings, credentials_ciphertext=EXCLUDED.credentials_ciphertext,
         updated_at=now()`,
      [id, input.label, input.enabled, input.endpoint, JSON.stringify(input.settings),
        encryptSecret(JSON.stringify(credentials))],
    );
    const saved = await getToolConnection(id);
    return { data: { connection: saved ? publicConnection(saved) : null, generatedDeviceToken } };
  });

  app.post('/v1/tools/phone.read/device-token', async (_request, reply) => {
    const existing = await getToolConnection('phone.read');
    const deviceToken = randomBytes(24).toString('base64url');
    const credentials = { ...(existing?.credentials ?? {}), deviceToken };
    if (!existing) {
      await pool.query(
        `INSERT INTO external_tool_connections
           (id, label, enabled, endpoint, settings, credentials_ciphertext, updated_at)
         VALUES ('phone.read','iPhone 屏幕查看',true,'','{}'::jsonb,$1,now())`,
        [encryptSecret(JSON.stringify(credentials))],
      );
    }
    await pool.query(
      `UPDATE external_tool_connections
       SET credentials_ciphertext=$2, updated_at=now()
       WHERE id=$1`,
      ['phone.read', encryptSecret(JSON.stringify(credentials))],
    );
    return {
      data: {
        deviceToken,
        pendingPath: '/v1/phone/peek/pending',
        uploadPath: '/v1/phone/peek/upload',
      },
    };
  });

  app.post('/v1/tools/:id/test', async (request, reply) => {
    const id = connectionIdSchema.parse((request.params as { id?: unknown }).id);
    const connection = await getToolConnection(id);
    if (!connection) return reply.code(404).send({ error: { code: 'not_found', message: '工具连接不存在。' } });
    try {
      const { testExternalToolConnection } = await import('./toolRunner.js');
      const message = await testExternalToolConnection(connection);
      await saveHealth(id, 'healthy', null);
      const refreshed = await getToolConnection(id);
      return { data: { ok: true, message, connection: refreshed ? publicConnection(refreshed) : null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接测试失败。';
      await saveHealth(id, 'unhealthy', message.slice(0, 2_000));
      const refreshed = await getToolConnection(id);
      return reply.code(400).send({
        error: { code: 'tool_unhealthy', message },
        data: { ok: false, connection: refreshed ? publicConnection(refreshed) : null },
      });
    }
  });
}
