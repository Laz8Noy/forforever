import type { Context } from '@deepseek-ai/cordis';
import type { Message, Session } from '../../core/types.ts';
import { maxOutputFor } from '../../core/types.ts';
import { esc, md, toast, promptModal } from '../dom.ts';
import { topbar, iconBtn, thinkingSelect } from '../shared.ts';
import { buildContext } from '../../chat/context.ts';
import { estimateTokens } from '../../core/tokens.ts';
import { estimateCost, fmtCost, priceLabel } from '../../api/pricing.ts';
import { ApiError } from '../../api/deepseek.ts';
import { uid } from '../../core/ids.ts';
import { now } from '../../core/time.ts';
import { onPageCleanup } from '../lifecycle.ts';

const PAGE_SIZE = 100;

export async function chatPage(ctx: Context, params: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const s = store.sessions.get(params.id)!;
  if (!s) {
    location.hash = '#/';
    return;
  }
  const char = store.characters.get(s.charId)!;
  if (!char) {
    toast('该人物已不存在', 'err');
    location.hash = '#/';
    return;
  }

  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);

  const titleEl = document.createElement('div');
  titleEl.className = 'title grow';
  titleEl.style.cursor = 'pointer';
  const renderTitle = () => {
    titleEl.innerHTML = `${esc(s.title)} <span class="subtitle">${esc(char.name)}</span>`;
  };
  renderTitle();
  titleEl.addEventListener('click', async () => {
    const name = await promptModal('重命名对话', s.title);
    if (name) {
      s.title = name;
      await store.saveSession(s);
      renderTitle();
    }
  });

  const thinkWrap = document.createElement('div');
  thinkWrap.appendChild(
    thinkingSelect(s.thinking, async (t) => {
      s.thinking = t;
      await store.saveSession(s);
      toast(`思考强度：${t.type === 'disabled' ? '关闭' : t.effort}`, 'info', 1200);
    }),
  );

  const bar = document.createElement('div');
  bar.className = 'topbar';
  const back = iconBtn('‹', () => (location.hash = '#/'));
  bar.appendChild(back);
  bar.appendChild(titleEl);
  bar.appendChild(thinkWrap);
  bar.appendChild(iconBtn('☰', () => window.dispatchEvent(new CustomEvent('ff/open-drawer', { detail: s.charId })), '会话抽屉'));
  page.appendChild(bar);

  const scroll = document.createElement('div');
  scroll.className = 'scroll chat-scroll';
  page.appendChild(scroll);

  const costHint = document.createElement('div');
  costHint.className = 'cost-hint';
  costHint.textContent = priceLabel(s.model);
  page.appendChild(costHint);

  const inputbar = document.createElement('div');
  inputbar.className = 'chat-inputbar';
  const ta = document.createElement('textarea');
  ta.rows = 1;
  ta.placeholder = `和 ${char.name} 说点什么…`;
  const sendBtn = document.createElement('button');
  sendBtn.className = 'send-btn';
  sendBtn.textContent = '↑';
  inputbar.appendChild(ta);
  inputbar.appendChild(sendBtn);
  page.appendChild(inputbar);

  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
  });

  let shownCount = PAGE_SIZE;
  let generating = false;
  let streamHandle: { cancel: () => void; done: Promise<void> } | null = null;
  let stickBottom = true;

  scroll.addEventListener('scroll', () => {
    stickBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  });
  const toBottom = (force = false) => {
    if (stickBottom || force) scroll.scrollTop = scroll.scrollHeight;
  };

  function thinkBlock(reasoning: string): HTMLElement {
    const block = document.createElement('div');
    block.className = 'think-block';
    const toggle = document.createElement('button');
    toggle.className = 'think-toggle';
    toggle.textContent = '💭 思考过程 ▸';
    const body = document.createElement('div');
    body.className = 'think-body';
    body.textContent = reasoning;
    toggle.addEventListener('click', () => {
      block.classList.toggle('open');
      toggle.textContent = block.classList.contains('open') ? '💭 思考过程 ▾' : '💭 思考过程 ▸';
    });
    block.appendChild(toggle);
    block.appendChild(body);
    return block;
  }

  function bubbleFor(m: Message): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role === 'user' ? 'user' : 'ai'}`;
    const b = document.createElement('div');
    if (m.error) {
      b.className = 'bubble error';
      b.textContent = m.error;
    } else if (m.role === 'user') {
      b.className = 'bubble';
      b.textContent = m.content;
    } else {
      b.className = 'bubble md';
      if (m.reasoning) wrap.appendChild(thinkBlock(m.reasoning));
      b.innerHTML = md(m.content);
    }
    wrap.appendChild(b);
    return wrap;
  }

  async function renderMessages(): Promise<void> {
    scroll.innerHTML = '';
    const msgs = await store.messages(s.id);
    if (msgs.length > shownCount) {
      const btn = document.createElement('button');
      btn.className = 'load-earlier';
      btn.textContent = `加载更早的 ${Math.min(PAGE_SIZE, msgs.length - shownCount)} 条`;
      btn.addEventListener('click', () => {
        shownCount += PAGE_SIZE;
        renderMessages();
      });
      scroll.appendChild(btn);
    }
    for (const m of msgs.slice(-shownCount)) scroll.appendChild(bubbleFor(m));
    toBottom(true);
  }

  // 首次进入：人物开场白
  const existing = await store.messages(s.id);
  if (!existing.length && char.greeting) {
    await store.appendMessage(s.id, { id: uid(), role: 'assistant', content: char.greeting, ts: now() });
  }
  await renderMessages();

  function setSendState(gen: boolean): void {
    generating = gen;
    sendBtn.textContent = gen ? '■' : '↑';
    sendBtn.classList.toggle('stop', gen);
    ta.disabled = gen;
  }

  async function generate(): Promise<void> {
    if (!store.secrets.apiKey) {
      toast('还没有设置 API key', 'err');
      location.hash = '#/settings';
      return;
    }
    const all = await store.messages(s.id);
    const entries = (await store.memoryEntries(char.id)).filter((e) => e.enabled && s.memoryTiers[e.level]);
    const selected = entries;
    const history = all.filter((m) => !m.error);
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;

    const built = buildContext({
      char,
      entries: selected,
      history: history.slice(0, -1),
      userText: lastUser.content,
      budget: store.settings.tokenBudget,
      thinking: s.thinking,
      calibration: store.settings.calibration,
    });
    if (built.droppedMemory > 0) toast(`记忆超出预算，已自动精简 ${built.droppedMemory} 条`, 'info');

    const estCost = estimateCost(s.model, built.estTokens, maxOutputFor(s.thinking) / 4);
    costHint.textContent = `本轮约 ${Math.round(built.estTokens / 1000)}K tokens · 预计 ${fmtCost(estCost)}（${priceLabel(s.model)}）`;

    // 实时气泡
    const live = document.createElement('div');
    live.className = 'msg ai';
    const thinkHolder = document.createElement('div');
    const b = document.createElement('div');
    b.className = 'bubble typing-cursor';
    live.appendChild(thinkHolder);
    live.appendChild(b);
    scroll.appendChild(live);
    toBottom(true);

    let content = '';
    let reasoning = '';
    let usage: Message['usage'];
    let thinkEl: HTMLElement | null = null;
    setSendState(true);

    const finish = async (error?: string) => {
      setSendState(false);
      streamHandle = null;
      b.classList.remove('typing-cursor');
      if (error) {
        live.remove();
        const errWrap = document.createElement('div');
        errWrap.className = 'msg ai';
        const eb = document.createElement('div');
        eb.className = 'bubble error';
        eb.textContent = error;
        const retry = document.createElement('button');
        retry.className = 'btn small mt';
        retry.textContent = '重试';
        retry.addEventListener('click', () => {
          errWrap.remove();
          generate();
        });
        eb.appendChild(document.createElement('br'));
        eb.appendChild(retry);
        errWrap.appendChild(eb);
        scroll.appendChild(errWrap);
        toBottom(true);
        return;
      }
      const m: Message = {
        id: uid(),
        role: 'assistant',
        content,
        reasoning: reasoning || undefined,
        ts: now(),
        usage,
        costEst: usage ? estimateCost(s.model, usage.prompt_tokens, usage.completion_tokens) : undefined,
      };
      await store.appendMessage(s.id, m);
      b.classList.add('md');
      b.innerHTML = md(content);
      if (m.costEst != null) costHint.textContent = `本轮实际 ${fmtCost(m.costEst)} · ${usage?.prompt_tokens ?? 0} 输入 / ${usage?.completion_tokens ?? 0} 输出 tokens`;
      if (s.title === '新的对话') {
        s.title = lastUser.content.slice(0, 16) + (lastUser.content.length > 16 ? '…' : '');
        await store.saveSession(s);
        renderTitle();
      }
      toBottom();
    };

    streamHandle = ctx.deepseek.stream(
      {
        model: s.model,
        thinking: s.thinking,
        messages: built.messages,
        maxTokens: maxOutputFor(s.thinking),
        estPromptTokens: built.estTokens,
      },
      {
        onReasoning(t) {
          reasoning += t;
          if (!thinkEl) {
            thinkEl = thinkBlock(reasoning);
            thinkHolder.appendChild(thinkEl);
          } else {
            thinkEl.querySelector('.think-body')!.textContent = reasoning;
          }
          toBottom();
        },
        onContent(t) {
          content += t;
          b.textContent = content;
          toBottom();
        },
        onUsage(u) {
          usage = u;
        },
      },
    );

    try {
      await streamHandle.done;
      if (!content && !reasoning) {
        await finish('没有收到回复内容，请重试');
      } else {
        await finish();
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '网络异常，请重试';
      if (content || reasoning) {
        await finish();
        toast('回复中断，已保留收到的部分内容，可继续对话', 'err', 4000);
      } else {
        await finish(msg);
      }
    }
  }

  async function send(): Promise<void> {
    const text = ta.value.trim();
    if (!text || generating) return;
    ta.value = '';
    ta.style.height = 'auto';
    const m: Message = { id: uid(), role: 'user', content: text, ts: now() };
    await store.appendMessage(s.id, m);
    scroll.appendChild(bubbleFor(m));
    stickBottom = true;
    toBottom(true);
    await store.touchActive();
    await generate();
  }

  sendBtn.addEventListener('click', () => {
    if (generating) {
      streamHandle?.cancel();
    } else {
      send();
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  onPageCleanup(() => {
    streamHandle?.cancel();
  });
}
