import type { APIConfig, ApiPreset } from '../types';

// Clipboard contents can carry zero-width characters that String.trim() does not
// remove. They are never valid at the edges of an API URL, token, or model id.
const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

const cleanEdgeCharacters = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

export const normalizeApiBaseUrl = (value: unknown): string =>
  // tokenrouter 官网门户在 www. 子域而 API 只开在 api.——从官网地址栏复制时容易
  // 把 www 填进来，表现为「Failed to fetch」（门户 HTML 无 CORS 头）。规范化时统一纠正；
  // 只精确匹配该域名，其他服务商的 www 不动。
  // 另外补一个高频手误：结尾的 `/1` 一定是 `/v1` 少打了 v（实测有人因此请求
  // https://api.xxx.com/1/models 而百思不解），只在末尾整段是 1 时纠正。
  cleanEdgeCharacters(value)
    .replace(/\/+$/, '')
    .replace(/^(https?:\/\/)www\.(tokenrouter\.com)/i, '$1api.$2')
    .replace(/\/1$/, '/v1');

export const fixApiHost = (value: unknown): string => normalizeApiBaseUrl(value);

export const normalizeApiCredential = (value: unknown): string =>
  cleanEdgeCharacters(value);

export const normalizeApiModel = (value: unknown): string =>
  cleanEdgeCharacters(value);

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  return {
    ...config,
    baseUrl: fixApiHost(config.baseUrl),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    ...(visionApi ? {
      visionApi: {
        enabled: visionApi.enabled === true,
        baseUrl: fixApiHost(visionApi.baseUrl),
        apiKey: normalizeApiCredential(visionApi.apiKey),
        model: normalizeApiModel(visionApi.model),
      },
    } : {}),
  };
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    config: normalizeApiConfig(preset.config),
  };
}
