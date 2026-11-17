import type { Character, MemoryEntry, Message } from '../core/types.ts';
import { MEMORY_TYPE_LABEL } from '../core/types.ts';
import { fmtDateTime } from '../core/time.ts';

// 所有框架 prompt 保持中性：只规定结构与职责，内容倾向完全由用户人设决定

export function chatFramework(charName: string): string {
  const d = new Date();
  return [
    `你是用户在这款长线陪伴聊天应用中创建的角色「${charName}」。`,
    `当前时间：${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}（用户本地时区）。`,
    '请始终以该角色的身份、语气和性格回应，保持人设一致，不要跳出角色，不要提及自己是模型或应用。',
    '长期记忆块是你们过往相处的沉淀，自然地参考它，让对话有 continuity；不要机械复述记忆内容。',
    '回应长度随场景自然变化：日常闲聊简短自然，重要时刻可以充分展开。',
  ].join('\n');
}

export function characterBlock(char: Character): string {
  return `【角色卡】\n名字：${char.name}\n人设：\n${char.persona}`;
}

export function memoryBlock(entries: MemoryEntry[]): string {
  if (!entries.length) return '';
  const parts: string[] = ['【长期记忆】以下是你与用户过往相处的记忆沉淀，分为两级：'];
  for (const level of ['user', 'character'] as const) {
    const group = entries.filter((e) => e.level === level);
    if (!group.length) continue;
    parts.push(level === 'user' ? '一级·用户记忆（关于用户的客观事实）：' : '二级·角色记忆（你自己的感受与关系记忆）：');
    const byType = new Map<string, string[]>();
    for (const e of group) {
      const label = MEMORY_TYPE_LABEL[e.type] ?? '其他';
      if (!byType.has(label)) byType.set(label, []);
      byType.get(label)!.push(`- ${e.content}`);
    }
    for (const [label, items] of byType) parts.push(`${label}：\n${items.join('\n')}`);
  }
  return parts.join('\n');
}

// 按 importance 裁剪记忆到 token 预算内（pinned 永不裁）
export function trimMemoryToBudget(
  entries: MemoryEntry[],
  budgetTokens: number,
  estimate: (s: string) => number,
): { kept: MemoryEntry[]; dropped: number } {
  const sorted = [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.importance - a.importance;
  });
  const kept: MemoryEntry[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of sorted) {
    const cost = estimate(e.content) + 6;
    if (e.pinned || used + cost <= budgetTokens) {
      kept.push(e);
      used += cost;
    } else {
      dropped++;
    }
  }
  return { kept, dropped };
}

export function buildTranscript(messages: Message[], charName: string): string {
  return messages
    .map((m) => `${m.role === 'user' ? '用户' : charName}：${m.content}`)
    .join('\n');
}

export function extractionSystem(char: Character, existing: MemoryEntry[]): string {
  const existingText = existing.length
    ? existing.map((e) => `[id=${e.id}] (${MEMORY_TYPE_LABEL[e.type]}) ${e.content}`).join('\n')
    : '（暂无记忆）';
  return [
    '你是一个中立的记忆档案管理员，为一段长线陪伴对话维护长期记忆。',
    `角色名字：${char.name}。角色人设摘要：${char.persona.slice(0, 500)}`,
    '任务：阅读【现有记忆】与【新增对话】，输出记忆更新操作。记忆分两级：',
    '- level=user（一级·用户记忆）：关于用户的客观事实、偏好、处境、重要事件。',
    '- level=character（二级·角色记忆）：你作为角色自己的主观感受、对用户的印象、关系进展、你在意的细节，可用第一人称书写。',
    '规则：',
    '1. 提炼值得长期记住的内容，分别归入两级。',
    '2. 与现有记忆重复的不要新增；已有记忆被新信息修正的用 update；明确过时或错误的用 delete。',
    '3. 只记录对话中真实出现的信息，不得虚构。琐碎寒暄不记录。',
    '4. importance 取 1-5：5=影响关系走向的重大事实，3=一般偏好与事件，1=边缘细节。',
    '5. type 取值：fact / event / preference / relationship / emotion。',
    '6. 每条 content 用一句简洁中文陈述（不超过60字）。',
    '7. 没有值得更新的内容时输出空操作。',
    '只输出 JSON，格式：{"add":[{"level":"user","type":"fact","content":"...","importance":3}],"update":[{"id":"...","content":"...","importance":3}],"delete":["id"]}',
    '',
    '【现有记忆】',
    existingText,
  ].join('\n');
}

export function diarySystem(char: Character): string {
  return [
    `现在请你完全成为「${char.name}」，以第一人称写一篇私人日记。`,
    '【角色卡】',
    char.persona,
    '',
    '写作要求：',
    '1. 口吻、用词、情感表达方式完全由上面的人设决定，像这个角色本人会在深夜写下的私密文字。',
    '2. 记述【近期相处】这段时间里与用户的相处、你的感受、你在意的小细节，以及你想对ta说却没说出口的话。',
    '3. 只基于提供的对话内容，不得虚构未发生的事；可以写角色的内心活动与情绪。',
    '4. 篇幅 200-500 字，自然分段，不要标题、不要日期行、不要 markdown 标记，纯文字。',
    '5. 这是角色自己的日记，不是总结报告，不要出现"记忆""系统""对话记录"这类词。',
  ].join('\n');
}

export function diaryUserPrompt(transcript: string, highlights: string, since: number): string {
  return [
    `【近期相处】（自 ${fmtDateTime(since)} 以来的对话）`,
    transcript || '（这段时间没有新的对话，写一篇关于等待与思念的短日记）',
    highlights ? `\n【这段时间沉淀下的记忆要点】\n${highlights}` : '',
  ].join('\n');
}