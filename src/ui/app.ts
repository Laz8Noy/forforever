import type { Context } from '@deepseek-ai/cordis';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Router } from './router.ts';
import { esc, toast } from './dom.ts';
import { avatarEl, applyAppearance } from './shared.ts';
import { fmtRelative } from '../core/time.ts';
import { onboardPage } from './pages/onboarding.ts';
import { homePage } from './pages/home.ts';
import { chatPage } from './pages/chat.ts';
import { charactersPage } from './pages/characters.ts';
import { characterEditPage } from './pages/character-edit.ts';
import { newSessionPage } from './pages/new-session.ts';
import { memoryManagePage } from './pages/memory-manage.ts';
import { diaryPage } from './pages/diary.ts';
import { settingsPage } from './pages/settings.ts';

export async function startUI(ctx: Context): Promise<void> {
  const store = ctx.store;
  const appEl = document.getElementById('app')!;
  appEl.innerHTML = `
    <div id="bg-layer"></div>
    <div id="bg-dim"></div>
    <div id="page" style="height:100%"></div>
    <div id="drawer-mask"></div>
    <aside id="drawer"></aside>
    <div id="toast-root"></div>`;

  await applyAppearance(ctx);

  const pageRoot = document.getElementById('page')!;
  const router = new Router(ctx, pageRoot, (path) => {
    if (!store.settings.onboarded && path !== '/welcome') return '/welcome';
    return null;
  });
  router.add('/welcome', onboardPage);
  router.add('/', homePage);
  router.add('/chat/:id', chatPage);
  router.add('/characters', charactersPage);
  router.add('/character/:id', characterEditPage);
  router.add('/new-session', newSessionPage);
  router.add('/memory/:charId', memoryManagePage);
  router.add('/diary/:charId', diaryPage);
  router.add('/settings', settingsPage);

  // ---------- 抽屉 ----------
  const drawer = document.getElementById('drawer')!;
  const mask = document.getElementById('drawer-mask')!;
  let drawerOpen = false;

  function closeDrawer(): void {
    drawerOpen = false;
    drawer.classList.remove('show');
    mask.classList.remove('show');
    drawer.style.transform = '';
  }

  async function openDrawer(charIdHint?: string): Promise<void> {
    const currentPath = router.current();
    const chatMatch = currentPath.match(/^\/chat\/(.+)$/);
    let charId = charIdHint;
    if (!charId && chatMatch) charId = store.sessions.get(chatMatch[1])?.charId;
    if (!charId) {
      const latest = [...store.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      charId = latest?.charId ?? [...store.characters.keys()][0];
    }
    const char = charId ? store.characters.get(charId) : undefined;

    drawer.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'drawer-head';
    if (char) {
      const card = document.createElement('div');
      card.className = 'drawer-char-card';
      card.innerHTML = `
        <div class="row">
          <div class="grow" style="min-width:0">
            <div style="font-weight:600;font-size:17px">${esc(char.name)}</div>
            <div class="tiny" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(char.persona.slice(0, 30))}</div>
          </div>
        </div>
        <div class="row mt">
          <button class="btn small grow" id="d-diary">📔 偷看日记</button>
          <button class="btn small grow" id="d-edit">编辑人物</button>
        </div>`;
      card.prepend(await avatarEl(ctx, char, true));
      card.querySelector('#d-diary')!.addEventListener('click', () => {
        closeDrawer();
        location.hash = `#/diary/${char.id}`;
      });
      card.querySelector('#d-edit')!.addEventListener('click', () => {
        closeDrawer();
        location.hash = `#/character/${char.id}`;
      });
      head.appendChild(card);
    } else {
      head.innerHTML = '<div class="drawer-char-card muted">还没有人物，先去创建一个吧</div>';
    }
    drawer.appendChild(head);

    const list = document.createElement('div');
    list.className = 'drawer-sessions';
    const sessions = [...store.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const s of sessions) {
      const c = store.characters.get(s.charId);
      const item = document.createElement('div');
      item.className = 'drawer-item' + (chatMatch && chatMatch[1] === s.id ? ' on' : '');
      item.innerHTML = `
        <span class="badge gray">${esc(c?.name ?? '?')}</span>
        <span class="t">${esc(s.title)}</span>
        <span class="tiny">${fmtRelative(s.lastActiveAt)}</span>`;
      item.addEventListener('click', () => {
        closeDrawer();
        location.hash = `#/chat/${s.id}`;
      });
      list.appendChild(item);
    }
    if (!sessions.length) list.innerHTML = '<p class="muted" style="padding:16px">还没有对话</p>';
    drawer.appendChild(list);

    const foot = document.createElement('div');
    foot.className = 'drawer-foot';
    foot.innerHTML = `
      <button class="btn small primary grow" id="d-new">＋ 新对话</button>
      <button class="btn small" id="d-chars">人物</button>
      <button class="btn small" id="d-settings">设置</button>`;
    foot.querySelector('#d-new')!.addEventListener('click', () => {
      closeDrawer();
      location.hash = '#/new-session';
    });
    foot.querySelector('#d-chars')!.addEventListener('click', () => {
      closeDrawer();
      location.hash = '#/characters';
    });
    foot.querySelector('#d-settings')!.addEventListener('click', () => {
      closeDrawer();
      location.hash = '#/settings';
    });
    drawer.appendChild(foot);

    drawerOpen = true;
    drawer.classList.add('show');
    mask.classList.add('show');
  }

  mask.addEventListener('click', closeDrawer);
  window.addEventListener('ff/open-drawer', (e) => openDrawer((e as CustomEvent).detail));

  // ---------- 左滑手势 ----------
  let sx = 0;
  let sy = 0;
  let intent: '' | 'h' | 'v' = '';
  pageRoot.addEventListener(
    'touchstart',
    (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      intent = '';
    },
    { passive: true },
  );
  pageRoot.addEventListener(
    'touchmove',
    (e) => {
      if (drawerOpen) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (!intent && Math.abs(dx) > 12 && Math.abs(dx) > 1.5 * Math.abs(dy)) intent = 'h';
      if (!intent && Math.abs(dy) > 12) intent = 'v';
      if (intent === 'h' && dx < -56) {
        intent = 'v';
        openDrawer();
      }
    },
    { passive: true },
  );

  // 抽屉右滑跟手关闭
  let dsx = 0;
  let ddrag = false;
  drawer.addEventListener(
    'touchstart',
    (e) => {
      dsx = e.touches[0].clientX;
      ddrag = true;
      drawer.classList.add('dragging');
    },
    { passive: true },
  );
  drawer.addEventListener(
    'touchmove',
    (e) => {
      if (!ddrag) return;
      const dx = Math.max(0, e.touches[0].clientX - dsx);
      drawer.style.transform = `translateX(${dx}px)`;
    },
    { passive: true },
  );
  drawer.addEventListener('touchend', (e) => {
    if (!ddrag) return;
    ddrag = false;
    drawer.classList.remove('dragging');
    const dx = e.changedTouches[0].clientX - dsx;
    if (dx > drawer.clientWidth * 0.35) closeDrawer();
    else drawer.style.transform = '';
  });

  // ---------- 离线检测 / 活跃度 ----------
  const onAway = () => {
    store.touchActive().catch(() => {});
  };
  const onBack = async () => {
    await ctx.memory.maybeAutoCollect().catch(() => {});
    await store.touchActive().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onAway();
    else onBack();
  });
  window.addEventListener('pagehide', onAway);
  if (Capacitor.isNativePlatform()) {
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onBack();
      else onAway();
    });
  }
  ctx.on('memory/deferred', (msg: string) => toast(msg, 'info', 4000));
  ctx.on('memory/status', (st) => {
    if (!st.running && st.lastOkAt && Date.now() - st.lastOkAt < 3000) {
      toast('ta 整理好了新的记忆和日记 📔', 'ok', 3000);
    }
  });

  // 启动时先检查离线收集（用上次持久化的 lastActiveAt），再刷新活跃时间
  await ctx.memory.maybeAutoCollect().catch(() => {});
  await store.touchActive().catch(() => {});

  await router.dispatch();
}