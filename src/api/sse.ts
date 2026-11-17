import type { Usage } from '../core/types.ts';

// 增量 SSE 解析：chunk 可能截断行/事件，维护缓冲按 \n\n 切完整事件
export class SSEParser {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) out.push(line.slice(5).trim());
      }
    }
    return out;
  }
}

export interface Delta {
  content: string;
  reasoning: string;
  done: boolean;
  usage?: Usage;
  error?: string;
}

export function parseDelta(data: string): Delta | null {
  if (data === '[DONE]') return { content: '', reasoning: '', done: true };
  let j: any;
  try {
    j = JSON.parse(data);
  } catch {
    return null;
  }
  if (j.error) {
    return { content: '', reasoning: '', done: true, error: j.error.message ?? String(j.error) };
  }
  const choice = j.choices?.[0];
  const d = choice?.delta ?? {};
  return {
    content: d.content ?? '',
    reasoning: d.reasoning_content ?? '',
    done: choice?.finish_reason != null,
    usage: j.usage ?? undefined,
  };
}