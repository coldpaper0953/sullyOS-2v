import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { capabilitiesWithAvailability, normalizeAutonomyPolicy } from './capabilities.js';
import { pool } from './db.js';
import { connectedCapabilityIds } from './toolConnections.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

const characterIdSchema = z.object({ characterId: z.string().min(1).max(200) });
const autonomyPatchSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(1_440),
  allowedCapabilityIds: z.array(z.string().min(1).max(100)).max(100).default(['memory.reflect']),
  approvalMode: z.enum(['read_only_auto', 'ask_all', 'trusted']).default('read_only_auto'),
  maxToolStepsPerWake: z.number().int().min(1).max(12).default(4),
  dailyToolBudget: z.number().int().min(0).max(200).default(20),
  idleThresholdMinutes: z.number().int().min(0).max(10_080).default(30),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(60),
  probabilityLevel: z.enum(['low', 'mid', 'high']).default('mid'),
  activityWindow: z.object({
    enabled: z.boolean(),
    start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }).default({ enabled: false, start: '08:00', end: '23:30' }),
  timezone: z.string().min(1).max(100).default('UTC'),
});

interface AgentSettingsRow {
  external_id: string;
  name: string;
  heartbeat_enabled: boolean;
  heartbeat_interval_minutes: number;
  timezone: string;
  autonomy_policy: unknown;
  last_heartbeat_at: Date | null;
  next_wake_at: Date | null;
  last_run_status: string | null;
  last_run_action: string | null;
  last_run_reason: string | null;
  last_run_error: string | null;
  last_run_at: Date | null;
}

function publicAgent(row: AgentSettingsRow) {
  return {
    characterId: row.external_id,
    name: row.name,
    enabled: row.heartbeat_enabled,
    intervalMinutes: row.heartbeat_interval_minutes,
    timezone: row.timezone,
    policy: normalizeAutonomyPolicy(row.autonomy_policy),
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    nextWakeAt: row.next_wake_at?.toISOString() ?? null,
    lastRun: row.last_run_at ? {
      status: row.last_run_status,
      action: row.last_run_action,
      reason: row.last_run_reason,
      error: row.last_run_error,
      at: row.last_run_at.toISOString(),
    } : null,
  };
}

export async function registerAgentSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/agents', async () => {
    const connectedIds = await connectedCapabilityIds();
    const result = await pool.query<AgentSettingsRow>(
      `SELECT a.external_id, a.name, a.heartbeat_enabled, a.heartbeat_interval_minutes, a.timezone,
              a.autonomy_policy, s.last_heartbeat_at, s.next_wake_at,
              wr.status AS last_run_status, wr.action AS last_run_action,
              wr.reason_summary AS last_run_reason, wr.error_message AS last_run_error,
              wr.started_at AS last_run_at
       FROM characters a
       LEFT JOIN agent_state s ON s.agent_id=a.id
       LEFT JOIN LATERAL (
         SELECT status, action, reason_summary, error_message, started_at
         FROM wake_runs WHERE agent_id=a.id ORDER BY started_at DESC LIMIT 1
       ) wr ON true
       WHERE a.owner_user_id=$1 AND a.external_id <> '__demo__'
       ORDER BY a.updated_at DESC`,
      [DEFAULT_USER_ID],
    );
    return {
      data: {
        agents: result.rows.map(publicAgent),
        capabilities: capabilitiesWithAvailability(connectedIds),
      },
    };
  });

  app.patch('/v1/agents/:characterId/autonomy', async (request, reply) => {
    const params = characterIdSchema.parse(request.params);
    const input = autonomyPatchSchema.parse(request.body);
    const policy = normalizeAutonomyPolicy(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `UPDATE characters
         SET heartbeat_enabled=$3,
             heartbeat_interval_minutes=$4,
             autonomy_policy=$5::jsonb,
             timezone=$6,
             updated_at=now()
         WHERE owner_user_id=$1 AND external_id=$2
         RETURNING id`,
        [DEFAULT_USER_ID, params.characterId, input.enabled, input.intervalMinutes, JSON.stringify(policy), input.timezone],
      );
      const agentId = result.rows[0]?.id;
      if (!agentId) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'character_not_found' });
      }
      await client.query(
        `INSERT INTO agent_state (agent_id, next_wake_at)
         VALUES ($1, now() + make_interval(mins => $2))
         ON CONFLICT (agent_id) DO UPDATE SET
           next_wake_at = CASE
             WHEN $3::boolean THEN now() + make_interval(mins => $2)
             ELSE agent_state.next_wake_at
           END,
           updated_at=now()`,
        [agentId, input.intervalMinutes, input.enabled],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const refreshed = await pool.query<AgentSettingsRow>(
      `SELECT a.external_id, a.name, a.heartbeat_enabled, a.heartbeat_interval_minutes, a.timezone,
              a.autonomy_policy, s.last_heartbeat_at, s.next_wake_at,
              wr.status AS last_run_status, wr.action AS last_run_action,
              wr.reason_summary AS last_run_reason, wr.error_message AS last_run_error,
              wr.started_at AS last_run_at
       FROM characters a LEFT JOIN agent_state s ON s.agent_id=a.id
       LEFT JOIN LATERAL (
         SELECT status, action, reason_summary, error_message, started_at
         FROM wake_runs WHERE agent_id=a.id ORDER BY started_at DESC LIMIT 1
       ) wr ON true
       WHERE a.owner_user_id=$1 AND a.external_id=$2`,
      [DEFAULT_USER_ID, params.characterId],
    );
    return { data: publicAgent(refreshed.rows[0]!) };
  });
}
