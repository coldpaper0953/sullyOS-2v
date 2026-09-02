import { describe, expect, it } from 'vitest';
import { extractDiscoveredModelIds } from '../src/modelProfiles.js';

describe('extractDiscoveredModelIds', () => {
  it('reads OpenAI-compatible data entries, removes duplicates and sorts them', () => {
    expect(extractDiscoveredModelIds({
      data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }],
    })).toEqual(['a-model', 'z-model']);
  });

  it('also accepts models arrays, string entries and common name fields', () => {
    expect(extractDiscoveredModelIds({
      models: ['plain-model', { name: 'named-model' }, { model: 'model-field' }, null],
    })).toEqual(['model-field', 'named-model', 'plain-model']);
  });
});
