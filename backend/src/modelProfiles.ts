import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { decryptSecret, encryptSecret } from './modelVault.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';
export const ENV_PROFILE_ID = 'env-primary';

export interface RuntimeModelProfile {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
  enabled: boolean;
  readOnly: boolean;
  healthStatus: 'unknown' | 'healthy' | 'unhealthy';
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
}

interface DbProfileRow {
  id: string;
  label: string;
  base_url: string;
  api_key_encrypted: string;
  model_name: string;
  priority: number;
  enabled: boolean;
  health_status: RuntimeModelProfile['healthStatus'];
  cooldown_until: Date | null;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error: string | null;
}

export interface ModelRoutingSettings {
  mode: 'auto' | 'fixed';
  activeProfileId: string | null;
  lastUsedProfileId: string | null;
}

function envProfile(): RuntimeModelProfile | null {
  if (!(config.MODEL_BASE_URL && config.MODEL_API_KEY && config.MODEL_NAME)) return null;
  return {
    id: ENV_PROFILE_ID,
    label: '环境变量主模型',
    baseUrl: config.MODEL_BASE_URL,
    apiKey: config.MODEL_API_KEY,
    model: config.MODEL_NAME,
    priority: 0,
    enabled: true,
    readOnly: true,
    healthStatus: 'unknown',
    cooldownUntil: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

async function getRoutingSettings(): Promise<ModelRoutingSettings> {
  const result = await pool.query<{
    mode: 'auto' | 'fixed';
    active_profile_ref: string | null;
    last_used_profile_ref: string | null;
  }>(
    `INSERT INTO model_routing_settings (owner_user_id)
     VALUES ($1)
     ON CONFLICT (owner_user_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id
     RETURNING mode, active_profile_ref, last_used_profile_ref`,
    [DEFAULT_USER_ID],
  );
  const row = result.rows[0];
  return {
    mode: row?.mode ?? 'auto',
    activeProfileId: row?.active_profile_ref ?? null,
    lastUsedProfileId: row?.last_used_profile_ref ?? null,
  };
}

export async function listRuntimeModelProfiles(): Promise<RuntimeModelProfile[]> {
  const result = await pool.query<DbProfileRow>(
    `SELECT id, label, base_url, api_key_encrypted, model_name, priority, enabled,
            health_status, cooldown_until, consecutive_failures, last_success_at,
            last_failure_at, last_error
     FROM model_profiles
     WHERE owner_user_id = $1
     ORDER BY priority ASC, created_at ASC`,
    [DEFAULT_USER_ID],
  );
  const profiles = result.rows.map((row): RuntimeModelProfile => ({
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    apiKey: decryptSecret(row.api_key_encrypted),
    model: row.model_name,
    priority: row.priority,
    enabled: row.enabled,
    readOnly: false,
    healthStatus: row.health_status,
    cooldownUntil: row.cooldown_until,
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastError: row.last_error,
  }));
  const primary = envProfile();
  return primary ? [primary, ...profiles] : profiles;
}

export async function getModelRoutingState(): Promise<{
  routing: ModelRoutingSettings;
  profiles: RuntimeModelProfile[];
}> {
  const [routing, profiles] = await Promise.all([getRoutingSettings(), listRuntimeModelProfiles()]);
  return { routing, profiles };
}

export function publicProfile(profile: RuntimeModelProfile) {
  let providerOrigin: string | null = null;
  try { providerOrigin = new URL(profile.baseUrl).origin; } catch { /* validation handles stored URLs */ }
  return {
    id: profile.id,
    label: profile.label,
    model: profile.model,
    providerOrigin,
    priority: profile.priority,
    enabled: profile.enabled,
    readOnly: profile.readOnly,
    healthStatus: profile.healthStatus,
    cooldownUntil: profile.cooldownUntil?.toISOString() ?? null,
    consecutiveFailures: profile.consecutiveFailures,
    lastSuccessAt: profile.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: profile.lastFailureAt?.toISOString() ?? null,
    lastError: profile.lastError,
  };
}

export async function orderedModelProfiles(): Promise<{
  mode: ModelRoutingSettings['mode'];
  profiles: RuntimeModelProfile[];
}> {
  const { routing, profiles } = await getModelRoutingState();
  const enabled = profiles.filter((profile) => profile.enabled);
  const activeIndex = enabled.findIndex((profile) => profile.id === routing.activeProfileId);
  if (activeIndex > 0) {
    const [active] = enabled.splice(activeIndex, 1);
    if (active) enabled.unshift(active);
  }
  if (routing.mode === 'fixed') {
    return { mode: routing.mode, profiles: enabled.slice(0, 1) };
  }
  const now = Date.now();
  const available = enabled.filter((profile) => !profile.cooldownUntil || profile.cooldownUntil.getTime() <= now);
  return { mode: routing.mode, profiles: available.length > 0 ? available : enabled };
}

export async function recordModelSuccess(profile: RuntimeModelProfile): Promise<void> {
  if (!profile.readOnly) {
    await pool.query(
      `UPDATE model_profiles SET health_status = 'healthy', consecutive_failures = 0,
       cooldown_until = NULL, last_success_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2`,
      [profile.id, DEFAULT_USER_ID],
    );
  }
  await pool.query(
    `UPDATE model_routing_settings SET last_used_profile_ref = $2, updated_at = now()
     WHERE owner_user_id = $1`,
    [DEFAULT_USER_ID, profile.id],
  );
}

export async function recordModelFailure(profile: RuntimeModelProfile, error: string): Promise<void> {
  if (profile.readOnly) return;
  await pool.query(
    `UPDATE model_profiles SET health_status = 'unhealthy',
       consecutive_failures = consecutive_failures + 1,
       cooldown_until = now() + ($3::int * interval '1 millisecond'),
       last_failure_at = now(), last_error = $4, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2`,
    [profile.id, DEFAULT_USER_ID, config.MODEL_FAILURE_COOLDOWN_MS, error.slice(0, 800)],
  );
}

const profileInputSchema = z.object({
  label: z.string().min(1).max(100),
  baseUrl: z.url().max(2_000),
  apiKey: z.string().min(1).max(10_000),
  model: z.string().min(1).max(500),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
});

const profileUpdateSchema = profileInputSchema.partial().extend({
  apiKey: z.string().min(1).max(10_000).optional(),
});
const profileParamsSchema = z.object({ id: z.uuid() });
const routingSchema = z.object({
  mode: z.enum(['auto', 'fixed']),
  activeProfileId: z.string().min(1).max(200).nullable(),
});
const modelDiscoverySchema = z.object({
  baseUrl: z.url().max(2_000).refine((value) => /^https?:\/\//i.test(value), 'Only HTTP(S) URLs are supported.'),
  apiKey: z.string().min(1).max(10_000),
});

export function extractDiscoveredModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const nestedData = record?.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : null;
  const source = [record?.data, record?.models, nestedData?.models, payload]
    .find(Array.isArray);
  if (!Array.isArray(source)) return [];
  const ids = source.map((item) => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    const record = item as Record<string, unknown>;
    const value = record.id ?? record.name ?? record.model;
    return typeof value === 'string' ? value.trim() : '';
  }).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function registerModelProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/model/profiles', async () => {
    const state = await getModelRoutingState();
    return { data: { routing: state.routing, profiles: state.profiles.map(publicProfile) } };
  });

  app.post('/v1/model/discover', async (request, reply) => {
    const input = modelDiscoverySchema.parse(request.body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const baseUrl = input.baseUrl.replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return reply.code(502).send({
          error: 'model_discovery_failed',
          message: `模型列表接口返回 HTTP ${response.status}`,
        });
      }
      const text = await response.text();
      if (text.length > 2_000_000) {
        return reply.code(502).send({ error: 'model_discovery_failed', message: '模型列表响应过大' });
      }
      let payload: unknown;
      try { payload = text ? JSON.parse(text) : {}; }
      catch {
        return reply.code(502).send({ error: 'model_discovery_failed', message: '模型列表不是有效 JSON' });
      }
      const models = extractDiscoveredModelIds(payload);
      if (models.length === 0) {
        return reply.code(502).send({ error: 'model_discovery_failed', message: '接口没有返回可选择的模型' });
      }
      return { data: { models } };
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '拉取模型列表超时'
        : '无法连接模型列表接口';
      return reply.code(502).send({ error: 'model_discovery_failed', message });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post('/v1/model/profiles', async (request, reply) => {
    const input = profileInputSchema.parse(request.body);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO model_profiles
       (owner_user_id, label, base_url, api_key_encrypted, model_name, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [DEFAULT_USER_ID, input.label, input.baseUrl.replace(/\/+$/, ''), encryptSecret(input.apiKey), input.model, input.priority, input.enabled],
    );
    return reply.code(201).send({ data: { id: result.rows[0]?.id } });
  });

  app.patch('/v1/model/profiles/:id', async (request, reply) => {
    const params = profileParamsSchema.parse(request.params);
    const input = profileUpdateSchema.parse(request.body);
    const result = await pool.query(
      `UPDATE model_profiles SET
         label = COALESCE($3, label), base_url = COALESCE($4, base_url),
         api_key_encrypted = COALESCE($5, api_key_encrypted), model_name = COALESCE($6, model_name),
         priority = COALESCE($7, priority), enabled = COALESCE($8, enabled), updated_at = now()
       WHERE id = $1 AND owner_user_id = $2`,
      [params.id, DEFAULT_USER_ID, input.label ?? null, input.baseUrl?.replace(/\/+$/, '') ?? null,
        input.apiKey ? encryptSecret(input.apiKey) : null, input.model ?? null,
        input.priority ?? null, input.enabled ?? null],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'model_profile_not_found' });
    return { data: { updated: true } };
  });

  app.delete('/v1/model/profiles/:id', async (request, reply) => {
    const params = profileParamsSchema.parse(request.params);
    const result = await pool.query(
      'DELETE FROM model_profiles WHERE id = $1 AND owner_user_id = $2',
      [params.id, DEFAULT_USER_ID],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'model_profile_not_found' });
    return reply.code(204).send();
  });

  app.put('/v1/model/routing', async (request, reply) => {
    const input = routingSchema.parse(request.body);
    const profiles = await listRuntimeModelProfiles();
    if (input.activeProfileId && !profiles.some((profile) => profile.id === input.activeProfileId)) {
      return reply.code(400).send({ error: 'unknown_active_model_profile' });
    }
    await pool.query(
      `INSERT INTO model_routing_settings (owner_user_id, mode, active_profile_ref)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_user_id) DO UPDATE SET
         mode = EXCLUDED.mode, active_profile_ref = EXCLUDED.active_profile_ref, updated_at = now()`,
      [DEFAULT_USER_ID, input.mode, input.activeProfileId],
    );
    return { data: { mode: input.mode, activeProfileId: input.activeProfileId } };
  });
}
