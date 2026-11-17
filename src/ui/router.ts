import type { Context } from '@deepseek-ai/cordis';
import { runPageCleanups } from './lifecycle.ts';

export type PageFn = (ctx: Context, params: Record<string, string>, root: HTMLElement) => void | Promise<void>;

interface Route {
  parts: string[];
  fn: PageFn;
}

export class Router {
  private routes: Route[] = [];
  private cleanups: (() => void)[] = [];

  constructor(
    private ctx: Context,
    private root: HTMLElement,
    private guard?: (path: string) => string | null,
  ) {
    window.addEventListener('hashchange', () => this.dispatch());
  }

  addCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  add(path: string, fn: PageFn): void {
    this.routes.push({ parts: path.split('/').filter(Boolean), fn });
  }

  navigate(path: string): void {
    if (location.hash === '#' + path) this.dispatch();
    else location.hash = '#' + path;
  }

  back(fallback: string): void {
    if (history.length > 1) history.back();
    else this.navigate(fallback);
  }

  current(): string {
    return location.hash.slice(1) || '/';
  }

  async dispatch(): Promise<void> {
    runPageCleanups();
    for (const fn of this.cleanups.splice(0)) fn();
    const path = this.current();
    const redirect = this.guard?.(path);
    if (redirect && redirect !== path) {
      this.navigate(redirect);
      return;
    }
    const segs = path.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
        else if (r.parts[i] !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.root.innerHTML = '';
      await r.fn(this.ctx, params, this.root);
      return;
    }
    this.navigate('/');
  }
}