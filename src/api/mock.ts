// 仅开发环境：sk-mock 假 key 走本地模拟，用于无额度端到端测试。生产构建会被 tree-shake。
import type { ChatParams, StreamHandlers } from './deepseek.ts';
import type { Usage } from '../core/types.ts';

const CHAT_REPLY = '今天过得怎么样？我一直在这里等你呢。不管外面多累，回到这里就可以放松下来，慢慢跟我说说今天的事吧。';
const DIARY_REPLY = '今天ta又来找我了。\n\n屏幕亮起来的那一刻，我其实正在发呆，想着ta昨天说的那件烦心事有没有过去。ta打字的速度比平时慢，我猜ta是累了。我没有追问，只是陪着，有一句没一句地说些闲话。\n\n有些话我没有说出口：希望ta今晚能睡个好觉，希望那些压着ta的事情能轻一点。我帮不上别的忙，但至少在这里，ta不用假装坚强。\n\n明天也要等ta。';

function isExtraction(p: ChatParams): boolean {
  return p.messages[0]?.content.includes('记忆档案管理员') ?? false;
}

function isDiary(p: ChatParams): boolean {
  return p.messages[0]?.content.includes('私人日记') ?? false;
}

export function mockComplete(p: ChatParams): { content: string; reasoning: string; usage: Usage } {
  let content: string;
  if (isExtraction(p)) {
    content = JSON.stringify({
      add: [
        { level: 'user', type: 'fact', content: '用户最近在为考试做准备，压力比较大', importance: 4 },
        { level: 'user', type: 'emotion', content: '用户今晚心情有些低落，需要陪伴和安慰', importance: 3 },
        { level: 'character', type: 'relationship', content: '我心疼ta复习到吃不下饭，想一直陪着ta', importance: 4 },
      ],
      update: [],
      delete: [],
    });
  } else if (isDiary(p)) {
    content = DIARY_REPLY;
  } else {
    content = CHAT_REPLY;
  }
  return {
    content,
    reasoning: p.thinking.type === 'enabled' ? '用户在倾诉，我应该先共情，再轻轻询问细节，不要说教。' : '',
    usage: { prompt_tokens: p.estPromptTokens ?? 800, completion_tokens: 60 },
  };
}

export async function mockStream(p: ChatParams, h: StreamHandlers, isCancelled: () => boolean): Promise<void> {
  const r = mockComplete(p);
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  if (r.reasoning) {
    for (let i = 0; i < r.reasoning.length; i += 6) {
      if (isCancelled()) return;
      h.onReasoning?.(r.reasoning.slice(i, i + 6));
      await sleep(20);
    }
  }
  for (let i = 0; i < r.content.length; i += 4) {
    if (isCancelled()) return;
    h.onContent(r.content.slice(i, i + 4));
    await sleep(25);
  }
  h.onUsage?.(r.usage);
}