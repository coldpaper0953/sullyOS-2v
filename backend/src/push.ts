import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import webpush from 'web-push';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';
const MAX_DELIVERY_ATTEMPTS = 5;

const subscriptionSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientName: z.string().max(200).optional(),
  endpoint: z.url().max(4_000),
  keys: z.object({
    p256dh: z.string().min(1).max(2_000),
    auth: z.string().min(1).max(2_000),
  }),
  expirationTime: z.number().nullable().optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.url().max(4_000) });
const testSchema = z.object({ clientId: z.string().min(1).max(200).optional() });

export interface BackendPushPayload {
  messageKind: 'content';
  messageId: string;
  message: string;
  contactName: string;
  sentAt: number;
  metadata: {
    source: 'sullyos-backend';
    eventId: string;
    eventType: string;
    charId: string;
    charName: string;
  };
}

function pushConfigured(): boolean {
  return config.VAPID_PUBLIC_KEY.length > 60 && config.VAPID_PRIVATE_KEY.length > 20;
}

if (pushConfigured()) {
  webpush.setVapidDetails(config.VAPID_EMAIL, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
}

export async function enqueueWebPush(
  client: PoolClient,
  input: {
    eventId: string;
    eventType: string;
    characterId: string;
    characterName: string;
    body: string;
  },
): Promise<void> {
  const payload: BackendPushPayload = {
    messageKind: 'content',
    messageId: input.eventId,
    message: input.body.slice(0, 1_500),
    contactName: input.characterName,
    sentAt: Date.now(),
    metadata: {
      source: 'sullyos-backend',
      eventId: input.eventId,
      eventType: input.eventType,
      charId: input.characterId,
      charName: input.characterName,
    },
  };
  await client.query(
    `INSERT INTO outbox (event_id, delivery_type, payload)
     VALUES ($1, 'web_push', $2::jsonb)
     ON CONFLICT (event_id, delivery_type) DO UPDATE SET
       payload=EXCLUDED.payload,
       status='pending',
       available_at=now(),
       last_error=NULL`,
    [input.eventId, JSON.stringify(payload)],
  );
}

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function deliverPayload(payload: unknown, clientId?: string): Promise<{
  attempted: number;
  delivered: number;
  retryableFailures: number;
}> {
  if (!pushConfigured()) return { attempted: 0, delivered: 0, retryableFailures: 0 };
  const subscriptions = await pool.query<SubscriptionRow>(
    `SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE owner_user_id=$1 AND enabled=true
       AND ($2::text IS NULL OR client_id=$2)`,
    [DEFAULT_USER_ID, clientId ?? null],
  );
  let delivered = 0;
  let retryableFailures = 0;
  for (const subscription of subscriptions.rows) {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, JSON.stringify(payload), { TTL: 86_400, urgency: 'normal' });
      delivered += 1;
      await pool.query(
        `UPDATE push_subscriptions
         SET failure_count=0, last_success_at=now(), updated_at=now()
         WHERE id=$1`,
        [subscription.id],
      );
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0);
      const permanentlyGone = statusCode === 404 || statusCode === 410;
      if (!permanentlyGone) retryableFailures += 1;
      await pool.query(
        `UPDATE push_subscriptions
         SET enabled=CASE WHEN $2 THEN false ELSE enabled END,
             failure_count=failure_count+1,
             last_failure_at=now(), updated_at=now()
         WHERE id=$1`,
        [subscription.id, permanentlyGone],
      );
    }
  }
  return { attempted: subscriptions.rowCount ?? 0, delivered, retryableFailures };
}

export async function processPushOutbox(limit = 20): Promise<number> {
  if (!pushConfigured()) return 0;
  const claimed = await pool.query<{
    id: string;
    payload: unknown;
    attempt_count: number;
  }>(
    `UPDATE outbox o
     SET status='processing', attempt_count=attempt_count+1
     FROM (
       SELECT id FROM outbox
       WHERE delivery_type='web_push'
         AND status IN ('pending','failed')
         AND available_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ) due
     WHERE o.id=due.id
     RETURNING o.id, o.payload, o.attempt_count`,
    [limit],
  );

  for (const item of claimed.rows) {
    const result = await deliverPayload(item.payload);
    if (result.delivered > 0 || result.attempted === 0 || result.retryableFailures === 0) {
      await pool.query(
        `UPDATE outbox SET status='sent', delivered_at=now(),
           last_error=CASE WHEN $2::integer=0 THEN 'no active push subscriptions' ELSE NULL END
         WHERE id=$1`,
        [item.id, result.attempted],
      );
      continue;
    }
    if (item.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
      await pool.query(
        `UPDATE outbox SET status='sent', delivered_at=now(), last_error='push retry limit reached'
         WHERE id=$1`,
        [item.id],
      );
      continue;
    }
    const retryMinutes = Math.min(60, 2 ** item.attempt_count);
    await pool.query(
      `UPDATE outbox SET status='failed', available_at=now()+make_interval(mins=>$2),
         last_error='temporary push delivery failure'
       WHERE id=$1`,
      [item.id, retryMinutes],
    );
  }
  return claimed.rowCount ?? 0;
}

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/push/config', async () => {
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM push_subscriptions
       WHERE owner_user_id=$1 AND enabled=true`,
      [DEFAULT_USER_ID],
    );
    return {
      data: {
        configured: pushConfigured(),
        publicKey: pushConfigured() ? config.VAPID_PUBLIC_KEY : null,
        activeSubscriptions: Number(count.rows[0]?.count ?? 0),
      },
    };
  });

  app.post('/v1/push/subscriptions', async (request, reply) => {
    if (!pushConfigured()) return reply.code(409).send({ error: 'push_not_configured' });
    const input = subscriptionSchema.parse(request.body);
    await pool.query(
      `INSERT INTO sync_clients (client_id, owner_user_id, client_name, last_seen_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (client_id) DO UPDATE SET
         client_name=COALESCE(EXCLUDED.client_name, sync_clients.client_name),
         last_seen_at=now()`,
      [input.clientId, DEFAULT_USER_ID, input.clientName ?? null],
    );
    await pool.query(
      `INSERT INTO push_subscriptions
         (owner_user_id, client_id, endpoint, p256dh, auth, expiration_time, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner_user_id, endpoint) DO UPDATE SET
         client_id=EXCLUDED.client_id,
         p256dh=EXCLUDED.p256dh,
         auth=EXCLUDED.auth,
         expiration_time=EXCLUDED.expiration_time,
         user_agent=EXCLUDED.user_agent,
         enabled=true,
         failure_count=0,
         updated_at=now()`,
      [DEFAULT_USER_ID, input.clientId, input.endpoint, input.keys.p256dh, input.keys.auth,
        input.expirationTime ? new Date(input.expirationTime) : null, request.headers['user-agent'] ?? null],
    );
    return reply.code(201).send({ data: { enabled: true } });
  });

  app.delete('/v1/push/subscriptions', async (request) => {
    const input = unsubscribeSchema.parse(request.body);
    await pool.query(
      `UPDATE push_subscriptions SET enabled=false, updated_at=now()
       WHERE owner_user_id=$1 AND endpoint=$2`,
      [DEFAULT_USER_ID, input.endpoint],
    );
    return { data: { enabled: false } };
  });

  app.post('/v1/push/test', async (request, reply) => {
    if (!pushConfigured()) return reply.code(409).send({ error: 'push_not_configured' });
    const input = testSchema.parse(request.body ?? {});
    const payload: BackendPushPayload = {
      messageKind: 'content',
      messageId: crypto.randomUUID(),
      message: '后台推送测试成功。现在即使关闭网页，角色也能从 VPS 给这台设备发消息。',
      contactName: 'SullyOS',
      sentAt: Date.now(),
      metadata: {
        source: 'sullyos-backend',
        eventId: 'push-test',
        eventType: 'system_event',
        charId: '',
        charName: 'SullyOS',
      },
    };
    const result = await deliverPayload(payload, input.clientId);
    return { data: result };
  });
}
