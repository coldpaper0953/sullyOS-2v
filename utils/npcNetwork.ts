import type { NpcNetworkEntry } from '../types';

export interface RelevantNpcContext {
    id: string;
    name: string;
    persona: string;
    userRelation: string;
    userAffinity: number;
    characterRelation: string;
    characterAffinity: number;
}

export function relevantNpcNetwork(entries: NpcNetworkEntry[] | undefined, charId: string): RelevantNpcContext[] {
    return (entries || []).flatMap(entry => {
        const relation = entry.characterRelations?.find(item => item.charId === charId);
        if (!relation) return [];
        return [{
            id: entry.id,
            name: entry.name.trim(),
            persona: entry.persona.trim(),
            userRelation: entry.userRelation.trim(),
            userAffinity: Math.max(0, Math.min(100, Math.round(entry.userAffinity || 0))),
            characterRelation: relation.relation.trim(),
            characterAffinity: Math.max(0, Math.min(100, Math.round(relation.affinity || 0))),
        }];
    }).filter(entry => entry.name);
}

export function formatNpcNetworkContext(entries: NpcNetworkEntry[] | undefined, charId: string): string {
    const relevant = relevantNpcNetwork(entries, charId);
    if (relevant.length === 0) return '';
    const lines = relevant.map(npc =>
        `- ${npc.name}：${npc.persona || '无额外人设'}；和用户是“${npc.userRelation || '关系未定义'}”（好感 ${npc.userAffinity}/100）；和你是“${npc.characterRelation || '关系未定义'}”（好感 ${npc.characterAffinity}/100）`
    );
    return `### NPC 关系网\n这些是真实存在于你们共同生活中的旁人。只按已写明的关系理解，不擅自扩写复杂身世；可以在对话、日程安排和自主活动中自然考虑他们，但不要为了提 NPC 而强行提及。\n${lines.join('\n')}\n\n`;
}
