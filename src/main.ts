import './styles/app.css';
import './core/events.ts';
import { Context } from '@deepseek-ai/cordis';
import { FFPlugin, StorePlugin } from './core/store.ts';
import { DeepSeekPlugin } from './api/deepseek.ts';
import { MemoryPlugin } from './memory/collector.ts';
import { startUI } from './ui/app.ts';

const ctx = new Context();
ctx.plugin(FFPlugin);
ctx.inject(['ffs'], StorePlugin);
ctx.inject(['store'], DeepSeekPlugin);
ctx.inject(['ffs', 'store', 'deepseek'], MemoryPlugin);
ctx.inject(['store', 'deepseek', 'memory'], (c) => startUI(c));

if (import.meta.env.DEV) {
  ctx.inject(['ffs', 'store', 'deepseek', 'memory'], (c) => {
    (window as unknown as Record<string, unknown>).__ff = c;
  });
}

setTimeout(() => {
  if (!document.getElementById('page')?.childElementCount) {
    const app = document.getElementById('app');
    if (app && !app.childElementCount) {
      app.innerHTML = '<div style="padding:40px;text-align:center;color:#888">启动失败：请查看控制台日志</div>';
    }
  }
}, 6000);