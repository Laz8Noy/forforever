import type { Context } from '@deepseek-ai/cordis';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import type { Character, Thinking } from '../core/types.ts';
import { esc } from './dom.ts';
import { onPageCleanup } from './lifecycle.ts';

export const PLATFORM_URL = 'https://platform.deepseek.com/api_keys';

export async function openPlatform(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url: PLATFORM_URL, toolbarColor: '#4D6BFE' });
  } else {
    window.open(PLATFORM_URL, '_blank');
  }
}

export async function avatarEl(ctx: Context, char: Character | undefined, lg = false): Promise<HTMLElement> {
  const div = document.createElement('div');
  div.className = 'avatar' + (lg ? ' lg' : '');
  if (!char) {
    div.textContent = '?';
    return div;
  }
  const url = await ctx.store.imageUrl(char.avatar);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = char.name;
    div.appendChild(img);
  } else {
    div.textContent = char.name.slice(0, 1);
  }
  return div;
}

export const THINK_OPTIONS: { label: string; value: Thinking }[] = [
  { label: '关', value: { type: 'disabled', effort: 'low' } },
  { label: '低', value: { type: 'enabled', effort: 'low' } },
  { label: '高', value: { type: 'enabled', effort: 'high' } },
  { label: '满', value: { type: 'enabled', effort: 'max' } },
];

export function thinkingKey(t: Thinking): string {
  return t.type === 'disabled' ? 'off' : t.effort;
}

export function thinkingSelect(current: Thinking, onChange: (t: Thinking) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'think-select';
  const cur = thinkingKey(current);
  for (const opt of THINK_OPTIONS) {
    const b = document.createElement('button');
    b.textContent = opt.label;
    if (thinkingKey(opt.value) === cur) b.classList.add('on');
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(opt.value);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

export function topbar(title: string, opts?: { subtitle?: string; back?: () => void; right?: HTMLElement[] }): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'topbar';
  if (opts?.back) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.textContent = '‹';
    b.addEventListener('click', opts.back);
    bar.appendChild(b);
  }
  const t = document.createElement('div');
  t.className = 'title grow';
  t.innerHTML = esc(title) + (opts?.subtitle ? ` <span class="subtitle">${esc(opts.subtitle)}</span>` : '');
  bar.appendChild(t);
  for (const r of opts?.right ?? []) bar.appendChild(r);
  return bar;
}

export function iconBtn(glyph: string, onClick: () => void, title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export async function applyAppearance(ctx: Context): Promise<void> {
  const { theme, backgroundPath, bgDim } = ctx.store.settings;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  const bg = document.getElementById('bg-layer');
  const dim = document.getElementById('bg-dim');
  if (!bg || !dim) return;
  if (backgroundPath) {
    const url = await ctx.store.imageUrl(backgroundPath);
    if (url) {
      bg.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
      bg.style.display = 'block';
      dim.style.display = 'block';
      dim.style.opacity = String(bgDim);
      document.body.classList.add('has-bg');
      return;
    }
  }
  bg.style.display = 'none';
  dim.style.display = 'none';
  document.body.classList.remove('has-bg');
}

export function statusDot(ctx: Context): HTMLElement {
  const el = document.createElement('span');
  const render = () => {
    const st = ctx.memory.status;
    el.className = 'status-dot' + (st.running ? ' busy' : st.lastError ? ' err' : '');
    el.innerHTML = `<i></i>${st.running ? `整理记忆 · ${esc(st.current ?? '')}` : st.lastError ? '记忆收集出错' : '记忆正常'}`;
    el.title = st.lastError ?? '';
  };
  render();
  const un = ctx.on('memory/status', render);
  onPageCleanup(() => un());
  return el;
}