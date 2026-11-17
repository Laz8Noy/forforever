import type { ModelId, Usage } from '../core/types.ts';
import { isOffPeak } from '../core/time.ts';

// 元 / 百万 tokens（2026-11 官方价目；缓存命中实际更便宜，估算按未命中保守计）
export const PRICES: Record<ModelId, { inOff: number; inPeak: number; outOff: number; outPeak: number }> = {
  'deepseek-flash': { inOff: 1, inPeak: 2, outOff: 4, outPeak: 8 },
  'deepseek-v4-pro': { inOff: 4.5, inPeak: 9, outOff: 13.5, outPeak: 27 },
};

export function estimateCost(
  model: ModelId,
  promptTokens: number,
  completionTokens: number,
  ts: number = Date.now(),
): number {
  const p = PRICES[model];
  const peak = !isOffPeak(ts);
  const pin = peak ? p.inPeak : p.inOff;
  const pout = peak ? p.outPeak : p.outOff;
  return (promptTokens * pin + completionTokens * pout) / 1e6;
}

export function costFromUsage(model: ModelId, usage: Usage, ts: number = Date.now()): number {
  return estimateCost(model, usage.prompt_tokens, usage.completion_tokens, ts);
}

export function priceLabel(model: ModelId, ts: number = Date.now()): string {
  const p = PRICES[model];
  const peak = !isOffPeak(ts);
  const name = model === 'deepseek-flash' ? 'Flash' : 'V4 Pro';
  return `${name} · ${peak ? '高峰' : '闲时'}价 输入¥${peak ? p.inPeak : p.inOff}/输出¥${peak ? p.outPeak : p.outOff} 每百万tokens`;
}

export function fmtCost(yuan: number): string {
  if (yuan < 0.01) return '<¥0.01';
  return `¥${yuan.toFixed(2)}`;
}