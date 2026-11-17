import { Context } from '@deepseek-ai/cordis';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { StreamHttp } from 'capacitor-stream-http';
import type { ModelId, Thinking, Usage, UsageLog } from '../core/types.ts';
import { SSEParser, parseDelta } from './sse.ts';
import { mockComplete, mockStream } from './mock.ts';
import { estimateCost } from './pricing.ts';
import { isOffPeak } from '../core/time.ts';
import type { Store } from '../core/store.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    public kind: 'auth' | 'balance' | 'moderation' | 'rate' | 'network' | 'server' | 'badrequest',
    public status = 0,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === 'rate' || this.kind === 'network' || this.kind === 'server';
  }
}

export interface ChatParams {
  model: ModelId;
  thinking: Thinking;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  responseFormat?: 'json_object';
  estPromptTokens?: number;
}

export interface StreamHandlers {
  onReasoning?: (text: string) => void;
  onContent: (text: string) => void;
  onUsage?: (u: Usage) => void;
}

export interface DeepSeek {
  testKey(key: string): Promise<{ ok: boolean; error?: string }>;
  complete(params: ChatParams, kind: UsageLog['kind']): Promise<{ content: string; reasoning: string; usage: Usage }>;
  stream(params: ChatParams, handlers: StreamHandlers): { cancel: () => void; done: Promise<void> };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepseek: DeepSeek;
  }
}

const NATIVE = Capacitor.isNativePlatform();
const BASE = NATIVE ? 'https://api.deepseek.com' : import.meta.env.DEV ? '/ds-api' : 'https://api.deepseek.com';
const URL_CHAT = `${BASE}/chat/completions`;

function buildPayload(p: ChatParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: p.messages,
    max_tokens: p.maxTokens,
    stream,
    thinking: { type: p.thinking.type },
  };
  if (p.thinking.type === 'enabled') body.reasoning_effort = p.thinking.effort;
  if (p.responseFormat) body.response_format = { type: p.responseFormat };
  return body;
}

function headers(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}

export function mapApiError(status: number, bodyText: string): ApiError {
  let msg = bodyText.slice(0, 300);
  try {
    const j = JSON.parse(bodyText);
    msg = j.error?.message ?? j.message ?? msg;
  } catch {
    /* 保留原文 */
  }
  if (status === 401) return new ApiError('API key 无效或已失效，请到设置里检查', 'auth', status);
  if (status === 402) return new ApiError('账户余额不足，请到 DeepSeek 开放平台充值', 'balance', status);
  if (status === 429) return new ApiError('请求过于频繁，稍后再试', 'rate', status);
  if (status === 400) {
    if (/content|filter|审核|敏感|moderat/i.test(msg)) {
      return new ApiError('这条内容没有通过平台内容审核，换个说法试试', 'moderation', status);
    }
    return new ApiError(`请求被拒绝：${msg}`, 'badrequest', status);
  }
  if (status >= 500) return new ApiError('DeepSeek 服务暂时不可用，稍后再试', 'server', status);
  return new ApiError(msg || `请求失败（${status}）`, 'badrequest', status);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [5000, 20000, 60000];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ApiError) || !e.retryable || i === delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  throw lastErr;
}

export async function DeepSeekPlugin(ctx: Context): Promise<void> {
  const store: Store = ctx.store;

  async function logUsage(kind: UsageLog['kind'], model: ModelId, usage: Usage, estPrompt?: number): Promise<void> {
    const ts = Date.now();
    const log: UsageLog = {
      ts,
      model,
      kind,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
      peak: !isOffPeak(ts),
      costEst: estimateCost(model, usage.prompt_tokens, usage.completion_tokens, ts),
    };
    await store.appendUsage(log).catch(() => {});
    // 用真实 prompt_tokens 滚动校准估算系数
    if (estPrompt && estPrompt > 200 && usage.prompt_tokens > 0) {
      const ratio = usage.prompt_tokens / estPrompt;
      const next = Math.min(2, Math.max(0.5, store.settings.calibration * 0.8 + ratio * 0.2));
      if (Math.abs(next - store.settings.calibration) > 0.05) {
        await store.saveSettings({ calibration: next }).catch(() => {});
      }
    }
  }

  async function rawComplete(p: ChatParams, key: string): Promise<{ content: string; reasoning: string; usage: Usage }> {
    if (import.meta.env.DEV && key === 'sk-mock') return mockComplete(p);
    const payload = buildPayload(p, false);
    let status: number;
    let data: any;
    if (NATIVE) {
      const r = await CapacitorHttp.post({
        url: URL_CHAT,
        headers: headers(key),
        data: payload,
        connectTimeout: 30000,
        readTimeout: 600000,
      });
      status = r.status;
      data = r.data;
    } else {
      const r = await fetch(URL_CHAT, { method: 'POST', headers: headers(key), body: JSON.stringify(payload) });
      status = r.status;
      data = await r.json().catch(() => ({}));
    }
    if (status < 200 || status >= 300) {
      throw mapApiError(status, typeof data === 'string' ? data : JSON.stringify(data));
    }
    const choice = data.choices?.[0];
    if (!choice) throw new ApiError('服务返回异常：缺少回复内容', 'server', status);
    return {
      content: choice.message?.content ?? '',
      reasoning: choice.message?.reasoning_content ?? '',
      usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  const deepseek: DeepSeek = {
    async testKey(key) {
      try {
        await rawComplete(
          {
            model: 'deepseek-flash',
            thinking: { type: 'disabled', effort: 'low' },
            messages: [{ role: 'user', content: '你好' }],
            maxTokens: 8,
          },
          key,
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async complete(p, kind) {
      const key = store.secrets.apiKey;
      if (!key) throw new ApiError('尚未设置 API key', 'auth');
      const r = await withRetry(() => rawComplete(p, key));
      await logUsage(kind, p.model, r.usage, p.estPromptTokens);
      return r;
    },

    stream(p, handlers) {
      const key = store.secrets.apiKey;
      let cancelled = false;
      let receivedOutput = false;
      let cancelInner: () => void = () => {};
      let resolveCancelled: () => void = () => {};
      const cancellation = new Promise<void>((resolve) => { resolveCancelled = resolve; });
      // 即使底层请求不能立即取消，也不再更新页面或阻塞下一轮对话。
      const forward: StreamHandlers = {
        onContent(text) {
          if (cancelled) return;
          if (text) receivedOutput = true;
          handlers.onContent(text);
        },
        onReasoning(text) {
          if (cancelled) return;
          if (text) receivedOutput = true;
          handlers.onReasoning?.(text);
        },
        onUsage(usage) {
          if (!cancelled) handlers.onUsage?.(usage);
        },
      };
      const ctl = {
        isCancelled: () => cancelled,
        setCancel(fn: () => void) {
          cancelInner = fn;
          if (cancelled) fn();
        },
      };

      const work = (async () => {
        if (!key) throw new ApiError('尚未设置 API key', 'auth');
        if (import.meta.env.DEV && key === 'sk-mock') {
          await mockStream(p, forward, ctl.isCancelled);
          return;
        }
        if (NATIVE && store.settings.streamEnabled) {
          try {
            await nativeStream(p, key, forward, ctl);
            return;
          } catch (e) {
            if (cancelled) return;
            // 已输出的回复交给页面保留；重发会把两次生成拼在一起，还可能重复计费。
            if (receivedOutput || (e instanceof ApiError && !e.retryable)) throw e;
            console.warn('stream plugin failed, fallback', e);
          }
        }
        if (!NATIVE && store.settings.streamEnabled) {
          try {
            await webStream(p, key, forward, ctl);
            return;
          } catch (e) {
            if (cancelled) return;
            if (receivedOutput || (e instanceof ApiError && !e.retryable)) throw e;
            console.warn('web stream failed, fallback', e);
          }
        }
        await typewriterFallback(p, forward, ctl.isCancelled);
      })();

      return {
        cancel() {
          if (cancelled) return;
          cancelled = true;
          resolveCancelled();
          cancelInner();
        },
        done: Promise.race([work, cancellation]),
      };
    },
  };

  async function nativeStream(
    p: ChatParams,
    key: string,
    h: StreamHandlers,
    ctl: { isCancelled: () => boolean; setCancel: (fn: () => void) => void },
  ): Promise<void> {
    const parser = new SSEParser();
    let streamId = '';
    let errStatus = 0;
    let errBuf = '';
    let usage: Usage | undefined;
    let finished = false;
    const ended = new Promise<void>((resolve, reject) => {
      const cleanupFns: (() => void)[] = [];
      const cancelRequest = () => {
        if (streamId) void StreamHttp.cancelStream({ id: streamId }).catch(() => {});
      };
      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        for (const fn of cleanupFns) fn();
        if (err) {
          cancelRequest();
          reject(err);
        } else resolve();
      };
      const track = (listener: { remove(): void | Promise<void> }) => {
        const remove = () => {
          try { void Promise.resolve(listener.remove()).catch(() => {}); } catch { /* 清理不阻塞结束 */ }
        };
        if (finished) remove();
        else cleanupFns.push(remove);
      };

      // 安卓插件取消后不会再发 end/error，必须在这里主动结束并清理监听器。
      ctl.setCancel(() => {
        cancelRequest();
        finish();
      });
      if (ctl.isCancelled()) return;

      const reg = async () => {
        track(await StreamHttp.addListener('response', (ev) => {
          if (finished || ev.id !== streamId) return;
          if (ev.status !== 200) errStatus = ev.status;
        }));
        if (finished) return;
        track(await StreamHttp.addListener('chunk', (ev) => {
          if (finished || ev.id !== streamId || !ev.chunk) return;
          if (errStatus) {
            errBuf += ev.chunk;
            return;
          }
          for (const data of parser.push(ev.chunk)) {
            const d = parseDelta(data);
            if (!d) continue;
            if (d.error) {
              finish(new ApiError(d.error, 'server'));
              return;
            }
            if (d.usage) usage = d.usage;
            if (d.reasoning) h.onReasoning?.(d.reasoning);
            if (d.content) h.onContent(d.content);
          }
        }));
        if (finished) return;
        track(await StreamHttp.addListener('end', (ev) => {
          if (finished || ev.id !== streamId) return;
          if (errStatus) finish(mapApiError(errStatus, errBuf));
          else finish();
        }));
        if (finished) return;
        track(await StreamHttp.addListener('error', (ev) => {
          if (finished || ev.id !== streamId) return;
          if (ctl.isCancelled()) finish();
          else finish(new ApiError(ev.error ?? '网络连接中断', 'network'));
        }));
      };

      void (async () => {
        await reg();
        if (finished) return;
        const { id } = await StreamHttp.startStream({
          url: URL_CHAT,
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify(buildPayload(p, true)),
          connectTimeoutMillis: 30000,
        });
        streamId = id;
        // 取消可能发生在 startStream 返回 id 之前。
        if (finished || ctl.isCancelled()) cancelRequest();
      })().catch((e) => finish(new ApiError(String(e?.message ?? e), 'network')));
    });

    await ended;
    if (usage) {
      h.onUsage?.(usage);
      await logUsage('chat', p.model, usage, p.estPromptTokens);
    }
  }

  async function webStream(
    p: ChatParams,
    key: string,
    h: StreamHandlers,
    ctl: { isCancelled: () => boolean; setCancel: (fn: () => void) => void },
  ): Promise<void> {
    const ac = new AbortController();
    ctl.setCancel(() => ac.abort());
    if (ctl.isCancelled()) return;
    const res = await fetch(URL_CHAT, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(buildPayload(p, true)),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw mapApiError(res.status, await res.text().catch(() => ''));
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let usage: Usage | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const data of parser.push(decoder.decode(value, { stream: true }))) {
        const d = parseDelta(data);
        if (!d) continue;
        if (d.error) throw new ApiError(d.error, 'server');
        if (d.usage) usage = d.usage;
        if (d.reasoning) h.onReasoning?.(d.reasoning);
        if (d.content) h.onContent(d.content);
        if (d.done && !d.usage) {
          // finish_reason 先到、usage 后到的情况继续读
        }
      }
    }
    if (usage) {
      h.onUsage?.(usage);
      await logUsage('chat', p.model, usage, p.estPromptTokens);
    }
  }

  async function typewriterFallback(p: ChatParams, h: StreamHandlers, isCancelled: () => boolean): Promise<void> {
    const r = await withRetry(() => {
      if (isCancelled()) throw new DOMException('Aborted', 'AbortError');
      return rawComplete(p, store.secrets.apiKey);
    });
    await logUsage('chat', p.model, r.usage, p.estPromptTokens);
    if (isCancelled()) return;
    if (r.reasoning) h.onReasoning?.(r.reasoning);
    h.onUsage?.(r.usage);
    const text = r.content;
    let i = 0;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (isCancelled()) {
          clearInterval(timer);
          resolve();
          return;
        }
        const step = 3 + Math.floor(Math.random() * 4);
        h.onContent(text.slice(i, i + step));
        i += step;
        if (i >= text.length) {
          clearInterval(timer);
          resolve();
        }
      }, 18);
    });
  }

  ctx.provide('deepseek', deepseek);
}
