import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { buildAgentContextMessages } from './contextBuilder.js';
import { pool } from './db.js';
import {
  buildRecentDiaryAvoidance,
  parseGeneratedDiaryCompletion,
  pickDiaryFocusHint,
  rawCompletionText,
} from './diaryGeneration.js';
import { INDEPENDENT_DIARY_STYLE_GUIDE } from './diaryPrompt.js';
import { createChatCompletion } from './modelClient.js';

const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';
const paperStyleSchema = z.enum(['plain', 'grid', 'dot', 'lined', 'dark', 'pink']);
const characterIdSchema = z.string().min(1).max(200);
const diaryIdParamsSchema = z.object({ diaryId: z.uuid() });

const listSchema = z.object({
  characterId: characterIdSchema,
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const syncSchema = z.object({
  characterId: characterIdSchema,
  clientDiaryId: z.string().min(1).max(200),
  authorType: z.enum(['user', 'assistant']).default('user'),
  title: z.string().max(500).default(''),
  content: z.string().min(1).max(100_000),
  diaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paperStyle: paperStyleSchema.default('plain'),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const generateDiarySchema = z.object({
  characterId: characterIdSchema,
  instruction: z.string().trim().max(500).optional(),
});
const commentSchema = z.object({
  clientCommentId: z.string().min(1).max(200),
  content: z.string().trim().min(1).max(2_000),
  replyToId: z.uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

interface DiaryTarget {
  id: string;
  external_id: string | null;
  agent_id: string;
  conversation_id: string;
  character_external_id: string;
  character_name: string;
  author_type: 'user' | 'assistant';
  title: string;
  content: string;
  paper_style: string;
  diary_date: string | Date;
  metadata: Record<string, unknown>;
  event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DiaryCommentRow {
  id: string;
  diary_id: string;
  external_id: string | null;
  author_type: 'user' | 'assistant';
  content: string;
  reply_to_id: string | null;
  event_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function dateOnly(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function publicComment(row: DiaryCommentRow) {
  return {
    id: row.id,
    diaryId: row.diary_id,
    externalId: row.external_id,
    authorType: row.author_type,
    content: row.content,
    replyToId: row.reply_to_id,
    eventId: row.event_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function publicDiary(row: DiaryTarget, comments: DiaryCommentRow[] = []) {
  return {
    id: row.id,
    externalId: row.external_id,
    characterId: row.character_external_id,
    characterName: row.character_name,
    authorType: row.author_type,
    title: row.title,
    content: row.content,
    paperStyle: row.paper_style,
    diaryDate: dateOnly(row.diary_date),
    metadata: row.metadata ?? {},
    eventId: row.event_id,
    comments: comments.map(publicComment),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function getDiaryTarget(client: PoolClient, diaryId: string): Promise<DiaryTarget | null> {
  const result = await client.query<DiaryTarget>(
    `SELECT d.*, a.external_id AS character_external_id, a.name AS character_name
     FROM agent_diaries d
     JOIN characters a ON a.id=d.agent_id
     WHERE d.id=$1 AND a.owner_user_id=$2
     LIMIT 1`,
    [diaryId, DEFAULT_USER_ID],
  );
  return result.rows[0] ?? null;
}

export async function deleteDiaryWithEvents(client: PoolClient, diaryId: string): Promise<boolean> {
  const diary = await getDiaryTarget(client, diaryId);
  if (!diary) return false;

  const events = await client.query<{ event_id: string }>(
    'SELECT event_id FROM agent_diaries WHERE id=$1 AND event_id IS NOT NULL '
    + 'UNION SELECT event_id FROM diary_comments WHERE diary_id=$1 AND event_id IS NOT NULL',
    [diary.id],
  );
  const eventIds = events.rows.map((row) => row.event_id);
  if (eventIds.length > 0) {
    await client.query('DELETE FROM conversation_events WHERE id=ANY($1::uuid[])', [eventIds]);
  }
  await client.query('DELETE FROM agent_diaries WHERE id=$1', [diary.id]);
  return true;
}

async function insertComment(input: {
  client: PoolClient;
  diary: DiaryTarget;
  authorType: 'user' | 'assistant';
  content: string;
  externalId: string;
  replyToId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<DiaryCommentRow> {
  const existing = await input.client.query<DiaryCommentRow>(
    `SELECT * FROM diary_comments WHERE diary_id=$1 AND external_id=$2 LIMIT 1`,
    [input.diary.id, input.externalId],
  );
  if (existing.rows[0]) return existing.rows[0];

  let replyToId = input.replyToId ?? null;
  if (replyToId) {
    const replyTarget = await input.client.query<{ id: string }>(
      `SELECT id FROM diary_comments WHERE id=$1 AND diary_id=$2`,
      [replyToId, input.diary.id],
    );
    if (!replyTarget.rows[0]) replyToId = null;
  }

  const eventMetadata = {
    source: 'journal',
    diaryId: input.diary.id,
    diaryExternalId: input.diary.external_id,
    diaryTitle: input.diary.title,
    diaryDate: dateOnly(input.diary.diary_date),
    commentExternalId: input.externalId,
    replyToId,
    ...input.metadata,
  };
  const event = await input.client.query<{ id: string }>(
    `INSERT INTO conversation_events
       (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
     VALUES ($1,$2,'diary_comment',$3,$4::jsonb,$5)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING id`,
    [input.diary.conversation_id, input.authorType, input.content,
      JSON.stringify(eventMetadata), `diary-comment:${input.diary.id}:${input.externalId}`],
  );
  const inserted = await input.client.query<DiaryCommentRow>(
    `INSERT INTO diary_comments
       (diary_id, external_id, author_type, content, reply_to_id, event_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING *`,
    [input.diary.id, input.externalId, input.authorType, input.content, replyToId,
      event.rows[0]?.id ?? null, JSON.stringify(input.metadata ?? {})],
  );
  return inserted.rows[0]!;
}

function dateInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export async function registerDiaryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/diaries', async (request) => {
    const query = listSchema.parse(request.query);
    const diaries = await pool.query<DiaryTarget>(
      `SELECT d.*, a.external_id AS character_external_id, a.name AS character_name
       FROM agent_diaries d
       JOIN characters a ON a.id=d.agent_id
       WHERE a.owner_user_id=$1 AND a.external_id=$2 AND d.visibility='user_visible'
       ORDER BY d.diary_date DESC, d.created_at DESC
       LIMIT $3`,
      [DEFAULT_USER_ID, query.characterId, query.limit],
    );
    const ids = diaries.rows.map((diary) => diary.id);
    const comments = ids.length > 0
      ? await pool.query<DiaryCommentRow>(
        `SELECT * FROM diary_comments WHERE diary_id=ANY($1::uuid[]) ORDER BY created_at`,
        [ids],
      )
      : { rows: [] as DiaryCommentRow[] };
    const byDiary = new Map<string, DiaryCommentRow[]>();
    for (const comment of comments.rows) {
      const list = byDiary.get(comment.diary_id) ?? [];
      list.push(comment);
      byDiary.set(comment.diary_id, list);
    }
    return { data: diaries.rows.map((diary) => publicDiary(diary, byDiary.get(diary.id) ?? [])) };
  });

  app.delete('/v1/diaries/:diaryId', async (request, reply) => {
    const params = diaryIdParamsSchema.parse(request.params);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await deleteDiaryWithEvents(client, params.diaryId);
      if (!deleted) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'diary_not_found' });
      }
      await client.query('COMMIT');
      return { data: { id: params.diaryId, deleted: true } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/v1/diaries/generate', async (request, reply) => {
    const input = generateDiarySchema.parse(request.body ?? {});
    const ownerResult = await pool.query<{ name: string; timezone: string }>(
      `SELECT name, timezone FROM characters WHERE owner_user_id=$1 AND external_id=$2 LIMIT 1`,
      [DEFAULT_USER_ID, input.characterId],
    );
    const owner = ownerResult.rows[0];
    if (!owner) return reply.code(404).send({ error: 'character_not_found' });

    const context = await buildAgentContextMessages({
      characterId: input.characterId,
      purpose: 'heartbeat',
      excludeEventTypes: ['diary_entry', 'diary_comment'],
    });
    if (!context) return reply.code(409).send({ error: 'character_context_missing' });
    const diaryDate = dateInTimezone(owner.timezone || 'UTC');
    const alreadyWritten = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM agent_diaries
         WHERE agent_id=$1 AND author_type='assistant' AND visibility='user_visible' AND diary_date=$2::date
       ) AS exists`,
      [context.agentId, diaryDate],
    );
    if (alreadyWritten.rows[0]?.exists) {
      return reply.code(409).send({
        error: 'daily_diary_limit',
        message: '这个角色今天已经写过一篇日记了；零碎念头会留在聊天里。',
      });
    }
    const recentDiaries = await pool.query<{ diary_date: string | Date; title: string; content: string }>(
      `SELECT diary_date, title, content
       FROM agent_diaries
       WHERE agent_id=$1 AND author_type='assistant' AND visibility='user_visible'
       ORDER BY created_at DESC
       LIMIT 8`,
      [context.agentId],
    );
    const recentDiaryAvoidance = buildRecentDiaryAvoidance(recentDiaries.rows.map((diary) => ({
      diaryDate: diary.diary_date,
      title: diary.title,
      content: diary.content,
    })));
    const focusHint = pickDiaryFocusHint();
    const variationToken = crypto.randomUUID().slice(0, 8);
    const prompt = `
## 手动触发：写一篇属于你自己的日记
这次触发只是为了让日记功能可以被立即测试，不代表用户给你出了一道作文题。
请从你自己的近期经历、当下状态、记忆和真正想留下的念头里选择内容，写一篇独立日记。
最近聊天可以是生活背景，但不要写成对用户指令、用户消息或用户日记的回应，也不要提到“测试”“系统触发”或“被要求写日记”。
保留原版日记最重要的特点：写出至少一件用户不知道的、属于你自己的生活细节或没说出口的念头；但不要为了满足这一条硬编大事件。
${INDEPENDENT_DIARY_STYLE_GUIDE}

## 与近期日记拉开距离
下面是你最近写过的日记，只能当作排除表，不能续写、改写或模仿：
${recentDiaryAvoidance}
本篇不得复用上面日记的标题、核心事件、显眼数字、关键物件、主要场景或开头句式。除非事情确实有了新的变化，否则必须换一个生活切面。
本轮优先观察方向：${focusHint}。这只是帮助换角度，不必生硬完成。
内部变化标记：${variationToken}。它只用于避免重复和请求缓存，严禁出现在标题或正文中。

正文通常 150～500 字，标题像本人随手写下的，简短自然，不要概括全文。
${input.instruction ? `可参考的轻量灵感（不要照抄成回应）：${input.instruction}` : ''}

可以额外留下 0～2 张“画面卡片”，每张只用一句具体描述记录亲历却没有拍下来的画面。它不是照片，不能声称真的拍摄或上传了图片。

只返回 JSON，不要 Markdown：
{"title":"日记标题","content":"完整日记正文","paperStyle":"plain|grid|dot|lined|dark|pink","sceneCards":["一句具体画面描述"]}`;
    const diaryMessages = [...context.messages, { role: 'user' as const, content: prompt }];
    let completion = await createChatCompletion({
      messages: diaryMessages,
      temperature: 0.9,
      maxTokens: 1_500,
    });
    let generated = parseGeneratedDiaryCompletion(completion);
    if (!generated) {
      const malformed = rawCompletionText(completion).slice(0, 6_000);
      completion = await createChatCompletion({
        messages: [
          ...diaryMessages,
          { role: 'assistant', content: malformed },
          {
            role: 'user',
            content: '上一条输出不是可解析的 JSON。保留日记内容但修正格式；只返回一个合法 JSON 对象，必须包含 title、content、paperStyle，可选 sceneCards 字符串数组；不要代码围栏、json 前缀、解释或尾随文字。',
          },
        ],
        temperature: 0.45,
        maxTokens: 1_500,
      });
      generated = parseGeneratedDiaryCompletion(completion);
    }
    if (!generated) return reply.code(502).send({ error: 'empty_model_response', message: '模型没有生成可保存的日记' });

    const externalId = `manual-diary-${crypto.randomUUID()}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const eventMetadata = {
        source: 'manual-diary-trigger',
        diaryExternalId: externalId,
        title: generated.title,
        diaryDate,
        paperStyle: generated.paperStyle,
        authorType: 'assistant',
        sceneCards: generated.sceneCards,
      };
      const event = await client.query<{ id: string }>(
        `INSERT INTO conversation_events
           (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
         VALUES ($1,'assistant','diary_entry',$2,$3::jsonb,$4)
         RETURNING id`,
        [context.conversationId, generated.content, JSON.stringify(eventMetadata), `manual-diary:${externalId}`],
      );
      const eventId = event.rows[0]!.id;
      const diary = await client.query<{ id: string }>(
        `INSERT INTO agent_diaries
           (agent_id, conversation_id, event_id, external_id, author_type, title, content,
            diary_date, daily_slot, paper_style, visibility, metadata)
         VALUES ($1,$2,$3,$4,'assistant',$5,$6,$7::date,$7,$8,'user_visible',$9::jsonb)
         ON CONFLICT (agent_id, daily_slot)
           WHERE author_type='assistant' AND daily_slot IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [context.agentId, context.conversationId, eventId, externalId, generated.title,
          generated.content, diaryDate, generated.paperStyle,
          JSON.stringify({ source: 'manual-diary-trigger', sceneCards: generated.sceneCards })],
      );
      const diaryId = diary.rows[0]?.id;
      if (!diaryId) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'daily_diary_limit',
          message: '这个角色今天已经写过一篇日记了；零碎念头会留在聊天里。',
        });
      }
      await client.query(
        `UPDATE conversation_events SET metadata=metadata || $2::jsonb, updated_at=now() WHERE id=$1`,
        [eventId, JSON.stringify({ diaryId })],
      );
      await client.query(
        `UPDATE agent_state SET last_agent_activity_at=now(), last_autonomous_activity_at=now(),
           context_version=context_version+1, updated_at=now() WHERE agent_id=$1`,
        [context.agentId],
      );
      await client.query('COMMIT');
      const refreshed = await getDiaryTarget(client, diaryId);
      return reply.code(201).send({ data: publicDiary(refreshed!) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/v1/diaries/sync', async (request, reply) => {
    const input = syncSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query<{ agent_id: string; conversation_id: string; name: string }>(
        `SELECT a.id AS agent_id, c.id AS conversation_id, a.name
         FROM characters a JOIN conversations c ON c.agent_id=a.id
           AND c.external_id=CONCAT('private:', a.external_id)
         WHERE a.owner_user_id=$1 AND a.external_id=$2 LIMIT 1`,
        [DEFAULT_USER_ID, input.characterId],
      );
      const owner = target.rows[0];
      if (!owner) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'character_not_found' });
      }

      const existing = await client.query<DiaryTarget>(
        `SELECT d.*, a.external_id AS character_external_id, a.name AS character_name
         FROM agent_diaries d JOIN characters a ON a.id=d.agent_id
         WHERE d.agent_id=$1 AND d.external_id=$2 FOR UPDATE`,
        [owner.agent_id, input.clientDiaryId],
      );
      let diaryId = existing.rows[0]?.id;
      let eventId = existing.rows[0]?.event_id;
      if (!diaryId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO agent_diaries
             (agent_id, conversation_id, external_id, author_type, title, content, diary_date,
              paper_style, visibility, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,'user_visible',$9::jsonb)
           RETURNING id`,
          [owner.agent_id, owner.conversation_id, input.clientDiaryId, input.authorType,
            input.title, input.content, input.diaryDate, input.paperStyle, JSON.stringify(input.metadata)],
        );
        diaryId = created.rows[0]!.id;
      } else {
        await client.query(
          `UPDATE agent_diaries SET author_type=$3, title=$4, content=$5, diary_date=$6::date,
             paper_style=$7, metadata=$8::jsonb, updated_at=now()
           WHERE id=$1 AND agent_id=$2`,
          [diaryId, owner.agent_id, input.authorType, input.title, input.content,
            input.diaryDate, input.paperStyle, JSON.stringify(input.metadata)],
        );
      }

      const eventMetadata = {
        source: 'journal', diaryId, diaryExternalId: input.clientDiaryId,
        title: input.title, diaryDate: input.diaryDate, paperStyle: input.paperStyle,
        authorType: input.authorType,
      };
      if (eventId) {
        await client.query(
          `UPDATE conversation_events SET content=$2, metadata=$3::jsonb, updated_at=now() WHERE id=$1`,
          [eventId, input.content, JSON.stringify(eventMetadata)],
        );
      } else {
        const event = await client.query<{ id: string }>(
          `INSERT INTO conversation_events
             (conversation_id, actor_type, event_type, content, metadata, idempotency_key)
           VALUES ($1,$2,'diary_entry',$3,$4::jsonb,$5)
           ON CONFLICT (idempotency_key) DO UPDATE SET content=EXCLUDED.content,
             metadata=EXCLUDED.metadata, updated_at=now()
           RETURNING id`,
          [owner.conversation_id, input.authorType, input.content, JSON.stringify(eventMetadata),
            `diary:${owner.agent_id}:${input.clientDiaryId}`],
        );
        eventId = event.rows[0]!.id;
        await client.query(`UPDATE agent_diaries SET event_id=$2 WHERE id=$1`, [diaryId, eventId]);
      }
      await client.query('COMMIT');

      const refreshedClient = await pool.connect();
      try {
        const refreshed = await getDiaryTarget(refreshedClient, diaryId);
        return reply.code(existing.rows[0] ? 200 : 201).send({ data: publicDiary(refreshed!) });
      } finally {
        refreshedClient.release();
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/v1/diaries/:diaryId/comments', async (request, reply) => {
    const params = diaryIdParamsSchema.parse(request.params);
    const input = commentSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const diary = await getDiaryTarget(client, params.diaryId);
      if (!diary) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'diary_not_found' });
      }
      const comment = await insertComment({
        client, diary, authorType: 'user', content: input.content,
        externalId: input.clientCommentId, replyToId: input.replyToId, metadata: input.metadata,
      });
      await client.query('COMMIT');
      return reply.code(201).send({ data: publicComment(comment) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/v1/diaries/:diaryId/comments/respond', async (request, reply) => {
    const params = diaryIdParamsSchema.parse(request.params);
    const client = await pool.connect();
    try {
      const diary = await getDiaryTarget(client, params.diaryId);
      if (!diary) return reply.code(404).send({ error: 'diary_not_found' });
      const comments = await client.query<DiaryCommentRow>(
        `SELECT * FROM diary_comments WHERE diary_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [diary.id],
      );
      const ordered = comments.rows.reverse();
      const context = await buildAgentContextMessages({
        characterId: diary.character_external_id,
        purpose: 'chat',
      });
      if (!context) return reply.code(409).send({ error: 'character_context_missing' });
      const thread = ordered.map((comment) => (
        `${comment.author_type === 'user' ? '用户' : diary.character_name}：${comment.content}`
      )).join('\n');
      const prompt = `
## 日记 · 便签互动
用户正在和你通过日记旁边的便签互动。这不是普通聊天气泡，也绝不是让你另写一篇日记来回应。
日记作者：${diary.author_type === 'user' ? '用户' : '你'}
日期：${dateOnly(diary.diary_date)}
标题：${diary.title || '无题'}
正文：
${diary.content}

已有便签：
${thread || '（还没有）'}

请以角色本人的口吻贴一张新的便签，只写自然的一到两句话。可以回应用户最后的便签，
也可以说读完正文后的具体感受；不要写成客服回复，不要解释系统，不要输出 JSON 或 Markdown。`;
      const completion = await createChatCompletion({
        messages: [...context.messages, { role: 'user', content: prompt }],
        temperature: 0.75,
        maxTokens: 300,
      });
      const content = rawCompletionText(completion)
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim()
        .slice(0, 2_000);
      if (!content) return reply.code(502).send({ error: 'empty_model_response' });

      await client.query('BEGIN');
      const latestUser = [...ordered].reverse().find((comment) => comment.author_type === 'user');
      const comment = await insertComment({
        client,
        diary,
        authorType: 'assistant',
        content,
        externalId: `assistant-${crypto.randomUUID()}`,
        replyToId: latestUser?.id ?? null,
        metadata: { source: 'requested-diary-comment' },
      });
      await client.query('COMMIT');
      return reply.code(201).send({ data: publicComment(comment) });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may not have started */ }
      throw error;
    } finally {
      client.release();
    }
  });
}
