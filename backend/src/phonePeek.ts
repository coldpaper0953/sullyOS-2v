import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { buildAgentContextMessages } from './contextBuilder.js';
import { pool } from './db.js';
import { createChatCompletion } from './modelClient.js';
import { enqueueWebPush } from './push.js';
import { getToolConnection } from './toolConnections.js';

const uploadSchema = z.object({
  requestId: z.uuid(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
  imageBase64: z.string().min(100).max(7_500_000),
});
const imageParamsSchema = z.object({ requestId: z.uuid() });
const testPeekSchema = z.object({
  characterId: z.string().min(1).max(200),
  goal: z.string().max(1_000).optional().default('想看看你现在在做什么。'),
});

export const phonePeekReactionSchema = z.object({
  action: z.literal('message'),
  intent: z.enum(['tease', 'care', 'comment', 'curious']),
  content: z.string().trim().min(1).max(1_500),
  reasonSummary: z.string().max(300).default(''),
});

export type PhonePeekReaction = z.infer<typeof phonePeekReactionSchema>;

interface PeekRow {
  id: string;
  agent_id: string;
  external_id: string;
  agent_name: string;
  conversation_id: string;
  heartbeat_run_id: string | null;
  goal: string;
  expires_at: Date;
  image_mime_type?: string | null;
  image_bytes?: Buffer | null;
  status?: string;
  analysis?: string | null;
  reaction?: PhonePeekReaction | null;
  message_event_id?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function authorizeDevice(request: { headers: Record<string, unknown> }): Promise<boolean> {
  const connection = await getToolConnection('phone.read');
  if (!connection?.enabled || !connection.credentials.deviceToken) return false;
  const supplied = request.headers['x-sully-device-token'];
  return typeof supplied === 'string' && safeEqual(connection.credentials.deviceToken, supplied);
}

function boundedText(value: unknown, max = 8_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[已截断]`;
}

async function triggerShortcutEmail(requestId: string, goal: string): Promise<void> {
  const connection = await getToolConnection('phone.read');
  if (!connection) throw new Error('手机查看尚未配置。');
  const settings = connection.settings;
  const host = String(settings.smtpHost ?? '').trim();
  const user = String(settings.smtpUser ?? '').trim();
  const recipient = String(settings.recipientEmail ?? '').trim();
  const password = connection.credentials.smtpPassword ?? '';
  if (!host || !user || !recipient || !password) {
    throw new Error('手机查看缺少 SMTP 或收件邮箱配置。');
  }
  const port = Math.max(1, Math.min(65_535, Number(settings.smtpPort) || 465));
  const secure = settings.smtpSecure !== false;
  const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass: password } });
  await transport.sendMail({
    from: String(settings.senderEmail ?? user),
    to: recipient,
    subject: String(settings.subject ?? 'SullyOS 屏幕查看请求'),
    text: `SULLYOS_SCREEN_PEEK\nrequestId=${requestId}\ngoal=${goal.slice(0, 500)}\n`,
  });
}

export async function createPhonePeekRequest(input: {
  client: PoolClient;
  agentId: string;
  conversationId: string;
  heartbeatRunId: string | null;
  goal: string;
}): Promise<{ requestId: string; summary: string }> {
  const created = await input.client.query<{ id: string }>(
    `INSERT INTO phone_peek_requests
       (agent_id, conversation_id, heartbeat_run_id, goal)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [input.agentId, input.conversationId, input.heartbeatRunId, input.goal],
  );
  const requestId = created.rows[0]?.id;
  if (!requestId) throw new Error('无法创建手机查看请求。');
  try {
    await triggerShortcutEmail(requestId, input.goal);
  } catch (error) {
    await input.client.query(
      `UPDATE phone_peek_requests SET status='failed', error_message=$2, updated_at=now() WHERE id=$1`,
      [requestId, error instanceof Error ? error.message : '邮件触发失败'],
    );
    throw error;
  }
  return { requestId, summary: '已发出一次手机屏幕查看请求，等待 iPhone 快捷指令回传截图。' };
}

async function analyzePeek(row: PeekRow, image: Buffer, contentType: string): Promise<string> {
  const dataUrl = `data:${contentType};base64,${image.toString('base64')}`;
  const completion = await createChatCompletion({
    messages: [
      {
        role: 'system',
        content: '你负责谨慎读取一张手机当前屏幕截图。只做客观视觉观察，不扮演角色，不推测屏幕外事实，不输出建议。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `这是用户明确授权后，由手机快捷指令回传的当前屏幕截图。观察目标：${row.goal}\n列出屏幕中确实可见的应用、文字、活动与明显状态；不确定的内容明确标成不确定。不要替角色说话。` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    maxTokens: 900,
  });
  const first = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : '';
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回截图观察结果。');
  return boundedText(content.trim());
}

export function buildPhonePeekReactionPrompt(input: {
  characterName: string;
  goal: string;
  observation: string;
}): string {
  return `## 你刚刚主动看了一眼用户的手机屏幕
你是 ${input.characterName}。你在自由活动里已经决定来看看用户正在做什么，截图也成功回来了。下面的观察只是你私下看见的事实，不是要发给用户的报告：

原本想了解：${input.goal}
客观观察：${input.observation}

既然你已经主动来看，就要像一个真实的人一样对看到的某个具体细节作出反应。可以吐槽、评价、关心或追问，选择最符合你人设与关系的一种；通常只说一到两句，允许连发短句。不要复述整张屏幕，也不要假装知道截图之外的事情。

绝对禁止说“截图显示”“我识别到”“系统告诉我”“我看到你的屏幕”，禁止客观报告、客服式关心、监控腔、模板化问候和通用 AI 安慰。把观察消化成角色本人的视角、偏见、用词和情绪；每句准备说出口的话都要满足：这句话只有这个角色会这样说。

只返回 JSON：{"action":"message","intent":"tease|care|comment|curious","content":"角色会直接发给用户的一到两句自然反应","reasonSummary":"不超过一行的私下原因"}`;
}

function parseReaction(raw: string): PhonePeekReaction {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回手机观察决策 JSON。');
  const parsed = phonePeekReactionSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
  return parsed;
}

async function decidePeekReaction(row: PeekRow, observation: string): Promise<PhonePeekReaction> {
  const context = await buildAgentContextMessages({
    characterId: row.external_id,
    purpose: 'heartbeat',
    excludeEventTypes: ['tool_activity', 'autonomous_activity', 'activity_summary'],
  });
  if (!context) throw new Error('角色上下文尚未同步。');
  const completion = await createChatCompletion({
    messages: [
      ...context.messages,
      { role: 'user', content: buildPhonePeekReactionPrompt({
        characterName: row.agent_name, goal: row.goal, observation,
      }) },
    ],
    temperature: 0.85,
    maxTokens: 700,
  });
  const first = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
  const message = first && typeof first === 'object' ? (first as Record<string, unknown>).message : undefined;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : '';
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回手机观察后的角色决定。');
  return parseReaction(content);
}

export async function registerPhonePeekRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/phone/peek/pending', async (request, reply) => {
    if (!await authorizeDevice(request as any)) return reply.code(401).send({ error: 'unauthorized_device' });
    await pool.query(`UPDATE phone_peek_requests SET status='expired', updated_at=now() WHERE status='pending' AND expires_at <= now()`);
    const result = await pool.query<PeekRow>(
      `SELECT p.id, p.agent_id, a.external_id, a.name AS agent_name, p.conversation_id,
              p.heartbeat_run_id, p.goal, p.expires_at
       FROM phone_peek_requests p JOIN characters a ON a.id=p.agent_id
       WHERE p.status='pending' AND p.expires_at > now()
       ORDER BY p.created_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return { data: row ? { requestId: row.id, characterId: row.external_id, characterName: row.agent_name,
      goal: row.goal, expiresAt: row.expires_at.toISOString() } : null };
  });

  app.post('/v1/phone/peek/upload', async (request, reply) => {
    if (!await authorizeDevice(request as any)) return reply.code(401).send({ error: 'unauthorized_device' });
    const input = uploadSchema.parse(request.body);
    const image = Buffer.from(input.imageBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (image.length < 100 || image.length > 5_500_000) {
      return reply.code(413).send({ error: 'image_too_large', message: '截图需小于 5.5MB。' });
    }
    const claimed = await pool.query<PeekRow>(
      `UPDATE phone_peek_requests p SET status='uploaded', image_mime_type=$2,
              image_bytes=$3, uploaded_at=now(), updated_at=now()
       FROM characters a
       WHERE p.id=$1 AND p.agent_id=a.id AND p.status='pending' AND p.expires_at > now()
       RETURNING p.id, p.agent_id, a.external_id, a.name AS agent_name, p.conversation_id,
                 p.heartbeat_run_id, p.goal, p.expires_at`,
      [input.requestId, input.contentType, image],
    );
    const row = claimed.rows[0];
    if (!row) return reply.code(404).send({ error: 'peek_request_not_pending' });

    let status: 'analyzed' | 'failed' = 'analyzed';
    let analysis = '';
    let reaction: PhonePeekReaction | null = null;
    let reactionError = '';
    try {
      analysis = await analyzePeek(row, image, input.contentType);
      try {
        reaction = await decidePeekReaction(row, analysis);
      } catch (error) {
        reactionError = error instanceof Error ? error.message : '角色判断暂时失败。';
        status = 'failed';
      }
    } catch (error) {
      status = 'failed';
      analysis = `截图已收到，但暂时无法识别：${error instanceof Error ? error.message : '未知错误'}`;
      reactionError = '截图没有可靠识别。';
    }
    const client = await pool.connect();
    let screenshotEventId: string | undefined;
    let messageEventId: string | undefined;
    try {
      await client.query('BEGIN');
      const screenshotEvent = await client.query<{ id: string }>(
        `INSERT INTO conversation_events
           (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
         VALUES ($1,'user','user_message',$2,$3::jsonb,$4)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
         RETURNING id`,
        [row.conversation_id, `[用户按你的请求发来手机屏幕截图]\n${analysis}`, JSON.stringify({
          source: 'phone-peek', messageType: 'image', status, goal: row.goal,
          observation: analysis, ...(reactionError ? { reactionError } : {}),
          phonePeekRequestId: row.id, imagePath: `/v1/phone/peek/${row.id}/image`,
        }), `phone-peek:${row.id}:screenshot`],
      );
      screenshotEventId = screenshotEvent.rows[0]?.id;

      if (status === 'analyzed' && reaction) {
        const messageEvent = await client.query<{ id: string }>(
          `INSERT INTO conversation_events
             (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
           VALUES ($1,'assistant','proactive_message',$2,$3::jsonb,$4)
           ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
           RETURNING id`,
          [row.conversation_id, reaction.content.trim(), JSON.stringify({
            source: 'phone-peek-reaction', phonePeekRequestId: row.id, intent: reaction.intent,
          }), `phone-peek:${row.id}:reaction`],
        );
        messageEventId = messageEvent.rows[0]?.id;
        if (messageEventId) {
          await client.query(
            `INSERT INTO outbox (event_id, delivery_type, payload)
             VALUES ($1,'in_app',$2::jsonb) ON CONFLICT DO NOTHING`,
            [messageEventId, JSON.stringify({ eventId: messageEventId, type: 'proactive_message' })],
          );
          await enqueueWebPush(client, {
            eventId: messageEventId, eventType: 'proactive_message',
            characterId: row.external_id, characterName: row.agent_name, body: reaction.content.trim(),
          });
        }
      }

      await client.query(
        `UPDATE phone_peek_requests
         SET status=$2, analysis=$3, reaction=$4::jsonb, message_event_id=$5,
             analyzed_at=CASE WHEN $2='analyzed' THEN now() ELSE analyzed_at END,
             error_message=CASE WHEN $2='failed' THEN $3 ELSE NULL END,
             updated_at=now()
         WHERE id=$1`,
        [row.id, status, analysis, JSON.stringify(reaction), messageEventId ?? null],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { data: { requestId: row.id, status, analysis, reaction, screenshotEventId, messageEventId } };
  });

  app.post('/v1/phone/peek/test', async (request, reply) => {
    const input = testPeekSchema.parse(request.body);
    const target = await pool.query<PeekRow>(
      `SELECT a.id AS agent_id, a.external_id, a.name AS agent_name, c.id AS conversation_id
       FROM characters a
       JOIN conversations c ON c.agent_id=a.id
       WHERE a.external_id=$1
       ORDER BY c.created_at ASC LIMIT 1`,
      [input.characterId],
    );
    const row = target.rows[0];
    if (!row) return reply.code(404).send({ error: 'character_not_found' });
    const client = await pool.connect();
    try {
      const created = await createPhonePeekRequest({
        client, agentId: row.agent_id, conversationId: row.conversation_id,
        heartbeatRunId: null, goal: input.goal,
      });
      return { data: created };
    } finally {
      client.release();
    }
  });

  app.get('/v1/phone/peek/:requestId/status', async (request, reply) => {
    const params = imageParamsSchema.parse(request.params);
    const result = await pool.query<PeekRow>(
      `SELECT p.id, p.status, p.goal, p.expires_at, p.analysis, p.reaction,
              p.message_event_id, p.created_at, p.updated_at,
              a.external_id, a.name AS agent_name
       FROM phone_peek_requests p JOIN characters a ON a.id=p.agent_id
       WHERE p.id=$1`,
      [params.requestId],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'peek_request_not_found' });
    return { data: {
      requestId: row.id, status: row.status, goal: row.goal,
      expiresAt: row.expires_at.toISOString(), analysis: row.analysis ?? null,
      reaction: row.reaction ?? null, messageEventId: row.message_event_id ?? null,
      characterId: row.external_id, characterName: row.agent_name,
      createdAt: row.created_at?.toISOString(), updatedAt: row.updated_at?.toISOString(),
    } };
  });

  app.get('/v1/phone/peek/:requestId/image', async (request, reply) => {
    const params = imageParamsSchema.parse(request.params);
    const result = await pool.query<Pick<PeekRow, 'image_mime_type' | 'image_bytes'>>(
      `SELECT image_mime_type, image_bytes FROM phone_peek_requests WHERE id=$1`,
      [params.requestId],
    );
    const row = result.rows[0];
    if (!row?.image_bytes) return reply.code(404).send({ error: 'image_not_found' });
    return reply.type(row.image_mime_type || 'image/jpeg').send(row.image_bytes);
  });
}
