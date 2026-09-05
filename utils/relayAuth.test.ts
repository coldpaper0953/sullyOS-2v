import { afterEach, describe, expect, it } from 'vitest';
import { permitEnvApiKey } from '../api/_relayAuth';

describe('permitEnvApiKey（溢权转发器的门禁）', () => {
  const original = process.env.SULLY_RELAY_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.SULLY_RELAY_TOKEN;
    else process.env.SULLY_RELAY_TOKEN = original;
  });

  it('未设 SULLY_RELAY_TOKEN → 放行（向后兼容旧调用方）', () => {
    delete process.env.SULLY_RELAY_TOKEN;
    expect(permitEnvApiKey({ headers: {} })).toBe(true);
    expect(permitEnvApiKey({})).toBe(true);
  });

  it('设了 SULLY_RELAY_TOKEN → 只有头正确才放行', () => {
    process.env.SULLY_RELAY_TOKEN = 'secret123';
    expect(permitEnvApiKey({ headers: { 'x-sully-relay-token': 'secret123' } })).toBe(true);
    expect(permitEnvApiKey({ headers: { 'x-sully-relay-token': 'wrong' } })).toBe(false);
    expect(permitEnvApiKey({ headers: {} })).toBe(false);
  });

  it('SULLY_RELAY_TOKEN 是空白时当未设置处理', () => {
    process.env.SULLY_RELAY_TOKEN = '   ';
    expect(permitEnvApiKey({ headers: {} })).toBe(true);
  });
});
