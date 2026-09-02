import { config } from './config.js';
import {
  getModelRoutingState,
  orderedModelProfiles,
  publicProfile,
  recordModelFailure,
  recordModelSuccess,
  type RuntimeModelProfile,
} from './modelProfiles.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
  [key: string]: unknown;
}

interface ChatCompletionInput {
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
}

export class ModelConfigurationError extends Error {
  constructor(message = 'The backend model is not configured.') {
    super(message);
    this.name = 'ModelConfigurationError';
  }
}

export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

export async function getModelStatus(): Promise<{
  configured: boolean;
  model: string | null;
  providerOrigin: string | null;
  mode: 'auto' | 'fixed';
  activeProfileId: string | null;
  lastUsedProfileId: string | null;
  profiles: ReturnType<typeof publicProfile>[];
}> {
  const state = await getModelRoutingState();
  const active = state.profiles.find((profile) => profile.id === state.routing.activeProfileId)
    ?? state.profiles.find((profile) => profile.id === state.routing.lastUsedProfileId)
    ?? state.profiles.find((profile) => profile.enabled)
    ?? null;
  const safeActive = active ? publicProfile(active) : null;
  return {
    configured: state.profiles.some((profile) => profile.enabled),
    model: active?.model ?? null,
    providerOrigin: safeActive?.providerOrigin ?? null,
    mode: state.routing.mode,
    activeProfileId: state.routing.activeProfileId,
    lastUsedProfileId: state.routing.lastUsedProfileId,
    profiles: state.profiles.map(publicProfile),
  };
}

function chatCompletionsUrl(profile: RuntimeModelProfile): string {
  try {
    return `${new URL(profile.baseUrl).toString().replace(/\/+$/, '')}/chat/completions`;
  } catch {
    throw new ModelRequestError(`模型“${profile.label}”的 URL 无效。`);
  }
}

async function requestProfile(
  profile: RuntimeModelProfile,
  input: ChatCompletionInput,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(chatCompletionsUrl(profile), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages: input.messages,
        temperature: input.temperature ?? config.MODEL_TEMPERATURE,
        max_tokens: input.maxTokens ?? config.MODEL_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let body: unknown;
    try { body = bodyText ? JSON.parse(bodyText) : {}; }
    catch { body = null; }

    if (!response.ok) {
      const detail = bodyText.replace(/\s+/g, ' ').slice(0, 500);
      throw new ModelRequestError(
        `“${profile.label} / ${profile.model}”返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      );
    }
    if (!body || typeof body !== 'object') {
      throw new ModelRequestError(`“${profile.label} / ${profile.model}”没有返回有效 JSON。`);
    }

    const result = body as Record<string, unknown>;
    const choices = result.choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = first && typeof first === 'object'
      ? (first as Record<string, unknown>).message
      : undefined;
    const content = message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : undefined;
    if (typeof content !== 'string') {
      throw new ModelRequestError(`“${profile.label} / ${profile.model}”响应中缺少正文。`);
    }
    return result;
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelRequestError(`“${profile.label} / ${profile.model}”请求超时。`, 504);
    }
    throw new ModelRequestError(
      `“${profile.label} / ${profile.model}”请求失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function createChatCompletion(input: ChatCompletionInput): Promise<Record<string, unknown>> {
  const routing = await orderedModelProfiles();
  if (routing.profiles.length === 0) {
    throw new ModelConfigurationError('后端模型池为空，请在 SullyOS 设置页新增模型。');
  }

  const failures: string[] = [];
  const attempted: Array<{ id: string; label: string; model: string }> = [];
  for (const profile of routing.profiles) {
    attempted.push({ id: profile.id, label: profile.label, model: profile.model });
    try {
      const result = await requestProfile(profile, input);
      await recordModelSuccess(profile);
      return {
        ...result,
        sully_backend: {
          routingMode: routing.mode,
          profileId: profile.id,
          profileLabel: profile.label,
          model: profile.model,
          attempted,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      failures.push(message);
      await recordModelFailure(profile, message);
      if (routing.mode === 'fixed') break;
    }
  }

  throw new ModelRequestError(`模型池全部不可用：${failures.join('；')}`, 502);
}
