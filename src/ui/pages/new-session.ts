import type { Context } from '@deepseek-ai/cordis';
import type { ModelId, Thinking } from '../../core/types.ts';
import { esc, toast } from '../dom.ts';
import { avatarEl, topbar, thinkingSelect } from '../shared.ts';

export async function newSessionPage(ctx: Context, _p: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const chars = [...store.characters.values()];
  if (!chars.length) {
    toast('先创建一个人物吧', 'info');
    location.hash = '#/characters';
    return;
  }

  let charId = chars.length === 1 ? chars[0].id : '';
  let thinking: Thinking = { ...store.settings.defaultThinking };
  let model: ModelId = store.settings.defaultModel;
  const tiers = { user: true, character: true };

  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);
  page.appendChild(topbar('新建对话', { back: () => (location.hash = '#/') }));

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  page.appendChild(scroll);
  const box = document.createElement('div');
  box.className = 'container';
  scroll.appendChild(box);

  for (const c of chars) {
    const pick = document.createElement('div');
    pick.className = 'char-pick' + (c.id === charId ? ' on' : '');
    pick.innerHTML = `<div class="grow"><div style="font-weight:600">${esc(c.name)}</div><div class="tiny">${esc(c.persona.slice(0, 40))}</div></div>`;
    pick.prepend(await avatarEl(ctx, c));
    pick.addEventListener('click', () => {
      charId = c.id;
      box.querySelectorAll('.char-pick').forEach((el) => el.classList.remove('on'));
      pick.classList.add('on');
      createBtn.disabled = false;
    });
    box.appendChild(pick);
  }

  const opts = document.createElement('div');
  opts.className = 'card';
  opts.innerHTML = `
    <div class="setting-row">
      <div><div class="lbl">带入用户记忆</div><div class="sub">关于你的事实与偏好</div></div>
      <label class="switch"><input type="checkbox" id="tier-user" checked><i></i></label>
    </div>
    <div class="setting-row">
      <div><div class="lbl">带入角色记忆</div><div class="sub">ta 自己的感受与关系记忆</div></div>
      <label class="switch"><input type="checkbox" id="tier-char" checked><i></i></label>
    </div>
    <div class="setting-row">
      <div class="lbl">思考强度</div>
      <div id="think-holder"></div>
    </div>
    <div class="setting-row">
      <div class="lbl">模型</div>
      <select class="input" id="model" style="width:auto">
        <option value="deepseek-flash" ${model === 'deepseek-flash' ? 'selected' : ''}>flash</option>
        <option value="deepseek-v4-pro" ${model === 'deepseek-v4-pro' ? 'selected' : ''}>v4-pro</option>
      </select>
    </div>`;
  box.appendChild(opts);
  opts.querySelector('#think-holder')!.appendChild(thinkingSelect(thinking, (t) => (thinking = t)));
  opts.querySelector('#tier-user')!.addEventListener('change', (e) => (tiers.user = (e.target as HTMLInputElement).checked));
  opts.querySelector('#tier-char')!.addEventListener('change', (e) => (tiers.character = (e.target as HTMLInputElement).checked));
  opts.querySelector<HTMLSelectElement>('#model')!.addEventListener('change', (e) => (model = (e.target as HTMLSelectElement).value as ModelId));

  const foot = document.createElement('div');
  foot.className = 'container';
  const createBtn = document.createElement('button');
  createBtn.className = 'btn primary block';
  createBtn.id = 'create';
  createBtn.textContent = '开始对话';
  createBtn.disabled = !charId;
  createBtn.addEventListener('click', async () => {
    const s = await store.createSession(charId, { model, thinking, memoryTiers: { ...tiers } });
    location.hash = `#/chat/${s.id}`;
  });
  foot.appendChild(createBtn);
  page.appendChild(foot);
}