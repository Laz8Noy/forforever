import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '../../core/types.ts';
import { esc, toast, actionSheet, promptModal, confirm } from '../dom.ts';
import { avatarEl, topbar, iconBtn, statusDot } from '../shared.ts';
import { fmtRelative } from '../../core/time.ts';
import { onPageCleanup } from '../lifecycle.ts';

export async function homePage(ctx: Context, _p: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);

  const settingsBtn = iconBtn('⚙', () => (location.hash = '#/settings'), '设置');
  const charsBtn = iconBtn('👤', () => (location.hash = '#/characters'), '人物');
  page.appendChild(topbar('Forforever', { right: [statusDot(ctx), charsBtn, settingsBtn] }));

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  page.appendChild(scroll);

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.textContent = '＋';
  fab.title = '新建对话';
  fab.addEventListener('click', () => (location.hash = '#/new-session'));
  page.appendChild(fab);

  async function renderList(): Promise<void> {
    scroll.innerHTML = '';
    const sessions = [...store.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `
        <div class="big">💬</div>
        <p>${store.characters.size ? '还没有对话，点右下角 ＋ 开始' : '先创建一个属于你的人物吧'}</p>
        <button class="btn primary mt" id="empty-cta">${store.characters.size ? '新建对话' : '创建人物'}</button>`;
      scroll.appendChild(empty);
      empty.querySelector('#empty-cta')!.addEventListener('click', () => {
        location.hash = store.characters.size ? '#/new-session' : '#/characters';
      });
      return;
    }
    const box = document.createElement('div');
    box.className = 'container';
    scroll.appendChild(box);
    for (const s of sessions) {
      const char = store.characters.get(s.charId);
      const item = document.createElement('div');
      item.className = 'session-item card';
      const msgs = await store.messages(s.id);
      const last = msgs[msgs.length - 1];
      const preview = last ? (last.role === 'user' ? '我：' : '') + last.content.slice(0, 40) : '还没有消息';
      item.innerHTML = `
        <div class="grow" style="min-width:0">
          <div class="name"><span class="char-prefix">${esc(char?.name ?? '未知人物')}</span>${esc(s.title)}</div>
          <div class="preview">${esc(preview)}</div>
        </div>
        <span class="time">${fmtRelative(s.lastActiveAt)}</span>
        <button class="icon-btn more" style="width:28px">⋯</button>`;
      const av = await avatarEl(ctx, char);
      item.prepend(av);
      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.more')) return;
        location.hash = `#/chat/${s.id}`;
      });
      item.querySelector('.more')!.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = await actionSheet(s.title, [
          { label: '重命名', value: 'rename' },
          { label: '删除对话', value: 'delete', danger: true },
        ]);
        if (act === 'rename') {
          const name = await promptModal('重命名对话', s.title);
          if (name) {
            s.title = name;
            await store.saveSession(s);
            renderList();
          }
        } else if (act === 'delete') {
          if (await confirm('删除对话', `确定删除「${s.title}」？聊天记录将一并删除，无法恢复。`, '删除', true)) {
            await store.deleteSession(s.id);
            renderList();
          }
        }
      });
      box.appendChild(item);
    }
  }

  await renderList();
  const un = ctx.on('store/session', () => renderList());
  onPageCleanup(() => un());
}