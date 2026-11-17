import type { Context } from '@deepseek-ai/cordis';
import { esc, toast, imageToJpeg } from '../dom.ts';
import { openPlatform } from '../shared.ts';
import { uid } from '../../core/ids.ts';
import { now } from '../../core/time.ts';
import { priceLabel } from '../../api/pricing.ts';

export async function onboardPage(ctx: Context, _p: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  let step = 0;
  let keyDraft = store.secrets.apiKey;
  let tested = false;
  let charName = '';
  let charPersona = '';
  let avatarBlob: Blob | null = null;

  const page = document.createElement('div');
  page.className = 'onboard';
  root.appendChild(page);

  const dots = () => `<div class="step-dots">${[0, 1, 2, 3].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>`;

  function render(): void {
    if (step === 0) {
      page.innerHTML = `
        <div class="onboard-body">
          <div style="font-size:52px;text-align:center;margin:30px 0 18px">🌙</div>
          <h1 style="text-align:center">Forforever</h1>
          <p style="text-align:center;font-size:15px">超长上下文，聊多久都记得。</p>
          <div class="card mt">
            <p>直连 DeepSeek 官方 API，<b>1M 超长上下文</b>——约百万字的对话同时在线，远超官方 App 的窗口上限。</p>
            <p>即使相伴日久、对话<b>超过上下文上限</b>，也有<b>两级长期记忆</b>兜底：你们的事被沉淀成本地文件，ta 记得你的偏好、你们的约定和关系进展，不会聊着聊着就忘了你。</p>
            <p>· 所有数据只存在你的手机本地<br>· 离线 3 小时回来，ta 会默默整理记忆、写下一篇人设口吻的日记<br>· 人物卡 + 私人日记，让每一段关系都能一直走下去</p>
          </div>
          <p class="tiny">开始之前，需要你准备一个 DeepSeek API key（按量计费，聊天成本很低）。下一步有详细教程。</p>
        </div>
        ${dots()}
        <div class="onboard-foot">
          ${store.settings.onboarded ? '<button class="btn" id="exit">返回首页</button>' : ''}
          <button class="btn primary grow" id="next">开始设置</button>
        </div>`;
      page.querySelector('#exit')?.addEventListener('click', () => (location.hash = '#/'));
      page.querySelector('#next')!.addEventListener('click', () => {
        step = 1;
        render();
      });
    } else if (step === 1) {
      page.innerHTML = `
        <div class="onboard-body">
          <h2>第一步：创建 API key</h2>
          <p>API key 是调用 DeepSeek 模型的凭证。它和官方 App 的会员无关，需要单独在<b>开放平台</b>创建并充值，按实际用量计费。</p>
          <div class="card">
            <div class="tutorial-step"><span class="n">1</span><div>打开 DeepSeek 开放平台，注册/登录账号</div></div>
            <div class="tutorial-step"><span class="n">2</span><div>完成实名认证（平台要求）</div></div>
            <div class="tutorial-step"><span class="n">3</span><div>左侧菜单「API keys」→ 创建 API key，复制保存好（只显示一次）</div></div>
            <div class="tutorial-step"><span class="n">4</span><div>「充值」里充少量金额即可开始，比如 10 元能用很久</div></div>
          </div>
          <button class="btn primary block" id="open-platform">🔗 打开 DeepSeek 开放平台</button>
          <div class="card mt">
            <p class="mb"><b>费用参考</b>（${esc(priceLabel('deepseek-flash'))}）</p>
            <p>日常陪伴聊天推荐 deepseek-flash：一次普通对话通常不到 1 分钱。北京时间 00:30–08:30 是闲时，价格减半。</p>
            <p class="tiny">提示：DeepSeek 官方 API 有内容审核，过于露骨的内容会被平台拒绝，这是平台规则，App 无法绕过。</p>
          </div>
        </div>
        ${dots()}
        <div class="onboard-foot">
          <button class="btn" id="prev">上一步</button>
          <button class="btn primary grow" id="next">我创建好了</button>
        </div>`;
      page.querySelector('#open-platform')!.addEventListener('click', () => openPlatform());
      page.querySelector('#prev')!.addEventListener('click', () => {
        step = 0;
        render();
      });
      page.querySelector('#next')!.addEventListener('click', () => {
        step = 2;
        render();
      });
    } else if (step === 2) {
      page.innerHTML = `
        <div class="onboard-body">
          <h2>第二步：填入并测试</h2>
          <p>把刚创建的 API key 粘贴到下面。key 只保存在你手机本地，不会上传到任何地方。</p>
          <div class="field">
            <label>API key（sk- 开头）</label>
            <input class="input" id="key" type="password" placeholder="sk-xxxxxxxxxxxxxxxx" value="${esc(keyDraft)}" autocomplete="off" />
          </div>
          <button class="btn block" id="test">测试连接</button>
          <div id="test-result" class="mt muted"></div>
        </div>
        ${dots()}
        <div class="onboard-foot">
          <button class="btn" id="prev">上一步</button>
          <button class="btn primary grow" id="next" ${tested ? '' : 'disabled'}>下一步</button>
        </div>`;
      const keyInput = page.querySelector<HTMLInputElement>('#key')!;
      const nextBtn = page.querySelector<HTMLButtonElement>('#next')!;
      const result = page.querySelector('#test-result')!;
      keyInput.addEventListener('input', () => {
        keyDraft = keyInput.value;
        tested = false;
        nextBtn.disabled = true;
      });
      page.querySelector('#test')!.addEventListener('click', async () => {
        const k = keyInput.value.trim();
        if (!k) return toast('请先粘贴 API key', 'err');
        result.textContent = '正在测试…';
        const r = await ctx.deepseek.testKey(k);
        if (r.ok) {
          tested = true;
          keyDraft = k;
          await store.setApiKey(k);
          result.innerHTML = '<span style="color:var(--ok)">✓ 连接成功，key 已保存</span>';
          nextBtn.disabled = false;
        } else {
          result.innerHTML = `<span style="color:var(--danger)">✗ ${esc(r.error ?? '连接失败')}</span>`;
        }
      });
      page.querySelector('#prev')!.addEventListener('click', () => {
        step = 1;
        render();
      });
      nextBtn.addEventListener('click', async () => {
        // key 配置成功即视为完成引导：中途退出不再重放欢迎页
        await store.saveSettings({ onboarded: true });
        step = 3;
        render();
      });
    } else {
      page.innerHTML = `
        <div class="onboard-body">
          <h2>第三步：创建第一个 ta</h2>
          <p>给 ta 起个名字，写下人设。人设决定 ta 的性格、说话方式和你们的关系——写得越具体，ta 越鲜活。日记也会完全按这个人设的口吻来写。</p>
          <div class="field"><label>名字</label><input class="input" id="cname" placeholder="比如：小晚" value="${esc(charName)}" /></div>
          <div class="field">
            <label>人设（性格 / 说话风格 / 你们的关系 / 背景故事）</label>
            <textarea class="input" id="cpersona" rows="7" placeholder="例如：小晚，26岁，插画师，性格温柔有点小迷糊。我们是认识三年的恋人，异地，每晚睡前聊天。她说话喜欢用短句，偶尔撒娇，生气时会假装冷淡但藏不住关心……">${esc(charPersona)}</textarea>
          </div>
          <div class="field">
            <label>头像（可选）</label>
            <input type="file" id="cavatar" accept="image/*" class="input" />
          </div>
          <p class="tiny">人设由你自己书写和负责。之后可以随时在「人物」里修改，也可以创建多个人物。</p>
        </div>
        ${dots()}
        <div class="onboard-foot">
          <button class="btn" id="skip">先跳过</button>
          <button class="btn primary grow" id="finish">创建并开始</button>
        </div>`;
      const nameInput = page.querySelector<HTMLInputElement>('#cname')!;
      const personaInput = page.querySelector<HTMLTextAreaElement>('#cpersona')!;
      nameInput.addEventListener('input', () => (charName = nameInput.value));
      personaInput.addEventListener('input', () => (charPersona = personaInput.value));
      page.querySelector<HTMLInputElement>('#cavatar')!.addEventListener('change', async (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) avatarBlob = await imageToJpeg(f, 512);
      });
      const finish = async (create: boolean) => {
        if (create) {
          if (!charName.trim()) return toast('给 ta 起个名字吧', 'err');
          if (!charPersona.trim()) return toast('写一点人设，ta 才知道自己是谁', 'err');
          const id = uid();
          let avatar: string | null = null;
          if (avatarBlob) avatar = await store.saveAvatar(id, avatarBlob);
          await store.saveCharacter({
            id,
            name: charName.trim(),
            persona: charPersona.trim(),
            avatar,
            greeting: '',
            createdAt: now(),
            updatedAt: now(),
          });
        }
        await store.saveSettings({ onboarded: true });
        location.hash = '#/';
      };
      page.querySelector('#skip')!.addEventListener('click', () => finish(false));
      page.querySelector('#finish')!.addEventListener('click', () => finish(true));
    }
  }

  render();
}