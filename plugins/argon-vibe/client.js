// Argon Vibe 任务编码视图（dsh client plugin）。
// 外壳：左文件列表 / 中间源码·Diff·运行区 / 右侧原生客户端保持不动。
// 数据全部来自本插件 /argon/vibe 只读路由；任务输入走主线
// POST /argon/api/work-items/:id/message（服务端阶段守卫，409 原因直接展示）。
window.__ModuleLoader__.load({ id: '@local/argon-vibe', factory: require => {
  const React = require('react');
  const BRIDGE_URL = window.__ARGON_VIBE_BRIDGE__ || '/argon/vibe/bridge-browser.mjs';
  const MONITOR_URL = '/argon/monitor-view.js';
  const PHASE_LABELS = {
    CLAIMED: '已接收', PREPARING: '准备工作区', BASELINE: '复现基线', PLANNING: '生成方案',
    AWAITING_PLAN_APPROVAL: '方案待审批', CODING: '执行修改', VERIFYING: '独立验证',
    AWAITING_REVIEW: '交付与审核', PUBLISHING: '交付中', PR_OPEN: 'PR 开放', CLOSING: '关闭中',
    COMPLETED: '已完成', BLOCKED: '已阻塞',
  };
  const phaseText = phase => PHASE_LABELS[phase] ?? phase ?? '—';
  const opLabel = op => ({ BASELINE: '基线测试', VERIFY: '独立验证', PLAN: '方案生成', BUILD: '构建检查' }[op?.kind] || op?.kind || '操作');

  return {
    inject: ['uiWorkspace', 'sessions', 'slots', 'conversation', 'sidebarRight', 'sidebarRightTabs'],
    async apply(ctx) {
      try {
        const query = new URLSearchParams(location.search);
        const workItemParam = query.get('argonVibeTask');
        if (!workItemParam || !/^work-[a-zA-Z0-9-]{1,140}$/.test(workItemParam)) return; // 非任务编码窗口，静默不激活
        const bridge = await import(/* @vite-ignore */ BRIDGE_URL);

        // ---- 绑定与代次 --------------------------------------------------
        // binding 三键（workItemId/sessionId/bindingId）；bindingId 即 generation
        // 令牌：任务或会话切换后重新生成，所有迟到响应按代次丢弃。
        let generation = 0;
        const binding = { workItemId: workItemParam, sessionId: query.get('argonSession') || null, bindingId: '' };
        const rebind = () => { generation += 1; binding.bindingId = crypto.randomUUID(); };
        rebind();
        let context = null;   // /context 最近一次快照
        let fileState = null; // { path, version, offset, limit, lines, eof, lineCount, seq }
        let fileSeq = 0;
        let activeTab = 'source';
        let diffCache = { etag: null, body: null };
        const dockActions = new Map(); // sessionId -> 原生 inputActions

        const enc = encodeURIComponent;
        const setStatus = text => { statusLine.textContent = text; };

        async function read(route) {
          const response = await fetch('/argon/vibe/' + route, { cache: 'no-store', credentials: 'same-origin' });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || ('请求失败（HTTP ' + response.status + '）'));
          return data;
        }
        async function api(path, { method = 'GET', body, mutation = false } = {}) {
          const headers = { Accept: 'application/json' };
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          if (mutation) { headers['X-Argon-Action'] = '1'; headers['Idempotency-Key'] = crypto.randomUUID(); }
          const response = await fetch('/argon/api' + path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const detail = data.error || data.message || data.detail;
            if (response.status === 401) throw new Error('登录状态已失效。请先在 DSH 主界面重新登录。');
            throw new Error(detail ? String(detail) : ('请求失败（HTTP ' + response.status + '）'));
          }
          return data;
        }

        // ---- 外壳 DOM ----------------------------------------------------
        const style = document.createElement('style');
        style.textContent = [
          '.av-root{position:fixed;top:0;left:0;bottom:0;width:46%;min-width:380px;z-index:40;display:flex;flex-direction:column;background:#f7f9fc;border-right:1px solid #d9e2ee;color:#1c2733;font:13px/1.5 -apple-system,"PingFang SC","Segoe UI",sans-serif;box-shadow:2px 0 12px rgba(20,40,70,.08)}',
          '.av-head{padding:8px 12px;border-bottom:1px solid #d9e2ee;background:#fff;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
          '.av-head .av-id{font-weight:600}.av-badge{padding:1px 8px;border-radius:10px;font-size:11px;background:#e3ecfb;color:#2055d6}',
          '.av-badge.av-blocked{background:#fde8e8;color:#b42318}.av-badge.av-paused{background:#fff4e0;color:#b25e09}',
          '.av-banner{padding:6px 12px;font-size:12px}.av-banner.av-blocked{background:#fde8e8;color:#b42318}.av-banner.av-paused{background:#fff4e0;color:#b25e09}',
          '.av-tabs{display:flex;gap:2px;padding:6px 12px 0;background:#fff;border-bottom:1px solid #d9e2ee}',
          '.av-tab{border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;padding:4px 14px;background:transparent;cursor:pointer;color:inherit}',
          '.av-tab[aria-selected="true"]{border-color:#d9e2ee;background:#f7f9fc;font-weight:600}',
          '.av-row{flex:1;display:flex;min-height:0}.av-tree{width:200px;overflow:auto;border-right:1px solid #d9e2ee;padding:6px 0;background:#fbfcfe}',
          '.av-file{display:block;width:100%;text-align:left;border:none;background:transparent;padding:4px 12px;cursor:pointer;color:inherit;font-size:12px}',
          '.av-file:hover{background:#eef3fa}.av-file[aria-current="true"]{background:#e3ecfb;color:#2055d6}',
          '.av-tree-empty{padding:8px 12px;color:#66788c;font-size:12px}',
          '.av-main{flex:1;display:flex;flex-direction:column;min-width:0}',
          '.av-meta{padding:6px 12px;border-bottom:1px solid #e4ebf4;color:#66788c;font-size:12px;display:flex;gap:10px;flex-wrap:wrap}',
          '.av-src{flex:1;overflow:auto;margin:0;padding:8px 12px;white-space:pre;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:4}',
          '.av-pager{padding:6px 12px;border-top:1px solid #e4ebf4;display:flex;gap:8px;align-items:center}',
          '.av-warn{margin:8px 12px;padding:6px 10px;background:#fff4e0;color:#b25e09;border-radius:6px;font-size:12px}',
          '.av-run{flex:1;overflow:auto;padding:8px}',
          '.av-foot{border-top:1px solid #d9e2ee;background:#fff;padding:8px 12px;display:flex;gap:8px;align-items:center}',
          '.av-foot input{flex:1;border:1px solid #d9e2ee;border-radius:6px;padding:6px 8px;font:inherit}',
          '.av-foot button{border:1px solid #2055d6;background:#2055d6;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer}',
          '.av-foot button:disabled{opacity:.5;cursor:default}',
          '.av-status{padding:4px 12px 8px;background:#fff;color:#66788c;font-size:12px}',
          '.av-root button.av-ghost{background:transparent;color:#2055d6;border-color:#d9e2ee}',
        ].join('\n');
        const root = document.createElement('section');
        root.className = 'av-root';
        root.setAttribute('aria-label', 'Argon 任务编码视图');
        const head = document.createElement('div'); head.className = 'av-head';
        const idSpan = document.createElement('span'); idSpan.className = 'av-id';
        const phaseBadge = document.createElement('span'); phaseBadge.className = 'av-badge';
        const versionBadge = document.createElement('span'); versionBadge.className = 'av-badge';
        head.append(idSpan, phaseBadge, versionBadge);
        const banner = document.createElement('div'); banner.className = 'av-banner'; banner.hidden = true;
        const tabsBar = document.createElement('div'); tabsBar.className = 'av-tabs';
        const tabDefs = [['source', '源码'], ['diff', 'Diff'], ['run', '运行']];
        const tabButtons = {};
        for (const [key, label] of tabDefs) {
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'av-tab'; btn.textContent = label; btn.setAttribute('aria-selected', String(key === activeTab));
          btn.addEventListener('click', () => switchTab(key));
          tabButtons[key] = btn; tabsBar.append(btn);
        }
        const quoteBtn = document.createElement('button');
        quoteBtn.type = 'button'; quoteBtn.className = 'av-ghost'; quoteBtn.textContent = '引用选区'; quoteBtn.title = '把源码选区作为只读快照引用插入原生草稿';
        quoteBtn.disabled = true;
        tabsBar.append(quoteBtn);
        const row = document.createElement('div'); row.className = 'av-row';
        const tree = document.createElement('nav'); tree.className = 'av-tree';
        const main = document.createElement('div'); main.className = 'av-main';
        const meta = document.createElement('div'); meta.className = 'av-meta';
        const srcPre = document.createElement('pre'); srcPre.className = 'av-src';
        const pager = document.createElement('div'); pager.className = 'av-pager'; pager.hidden = true;
        const runBox = document.createElement('div'); runBox.className = 'av-run'; runBox.hidden = true;
        main.append(meta, srcPre, pager, runBox);
        row.append(tree, main);
        const foot = document.createElement('div'); foot.className = 'av-foot';
        const input = document.createElement('input');
        input.placeholder = '向当前工作流发送补充说明（由服务端按阶段守卫）…';
        input.setAttribute('aria-label', '补充说明');
        const send = document.createElement('button'); send.type = 'button'; send.textContent = '发送';
        foot.append(input, send);
        const statusLine = document.createElement('div'); statusLine.className = 'av-status'; statusLine.textContent = '正在读取任务上下文…';
        root.append(style, head, banner, tabsBar, row, foot, statusLine);
        document.body.append(root);

        // ---- 上下文轮询与状态同步 ----------------------------------------
        function applyContext(next) {
          context = next;
          idSpan.textContent = next.workItemId;
          phaseBadge.textContent = phaseText(next.phase);
          phaseBadge.classList.toggle('av-blocked', !!next.blocked);
          versionBadge.textContent = 'version ' + next.version;
          const notes = [];
          if (next.blocked) { banner.hidden = false; banner.className = 'av-banner av-blocked'; banner.textContent = '已阻塞' + (next.reason ? '：' + next.reason : ''); }
          else if (next.paused) { banner.hidden = false; banner.className = 'av-banner av-paused'; banner.textContent = '工作流已暂停，输入仅会暂存，恢复后由工作流决定处理。'; }
          else banner.hidden = true;
          head.classList.toggle('av-paused', !!next.paused);
          quoteBtn.disabled = !fileState;
          renderTree();
          if (activeTab === 'run') renderRun();
          return notes;
        }
        async function loadContext() {
          const epoch = generation;
          try {
            const data = await read('tasks/' + enc(binding.workItemId) + '/context');
            if (epoch !== generation) return; // 迟到响应：绑定已切换，丢弃
            if (!binding.sessionId) {
              const sid = data.codeSessionId || data.planSessionId || null;
              if (sid) { binding.sessionId = sid; rebind(); } // 会话晚绑定，旧代次响应全部作废
            }
            applyContext(data);
            setStatus('上下文已同步 · version ' + data.version + (data.paused ? ' · 已暂停' : '') + (data.blocked ? ' · 已阻塞' : ''));
          } catch (error) {
            if (epoch === generation) setStatus('上下文读取失败：' + error.message);
          }
        }
        const refreshTimer = setInterval(() => { if (!document.hidden) { void loadContext(); if (activeTab === 'run') renderRun(); } }, 2000);

        // ---- 文件列表与只读源码 ------------------------------------------
        function knownFiles() {
          const files = [];
          const push = p => { if (typeof p === 'string' && p && !files.includes(p)) files.push(p); };
          push(context?.source?.sourcePath);
          for (const f of diffCache.body?.changedFiles || []) push(f);
          return files;
        }
        function renderTree() {
          tree.replaceChildren();
          const files = knownFiles();
          if (!files.length) { const empty = document.createElement('div'); empty.className = 'av-tree-empty'; empty.textContent = '暂无已知文件；可从原生侧栏文件链接跳转。'; tree.append(empty); return; }
          for (const path of files) {
            const btn = document.createElement('button');
            btn.type = 'button'; btn.className = 'av-file'; btn.textContent = path; btn.title = path;
            btn.setAttribute('aria-current', String(fileState?.path === path));
            btn.addEventListener('click', () => openFile(path));
            tree.append(btn);
          }
        }
        async function openFile(path, line = 1) {
          const epoch = ++fileSeq;
          const taskEpoch = generation;
          try {
            const first = await read('tasks/' + enc(binding.workItemId) + '/files?' + new URLSearchParams({ path, offset: 1, limit: 400 }));
            if (epoch !== fileSeq || taskEpoch !== generation) return;
            fileState = { ...first, seq: epoch };
            quoteBtn.disabled = false;
            renderFile();
            renderTree();
            const target = Math.max(0, line - 4);
            srcPre.scrollTop = target * 18.6;
            setStatus('已加载 ' + path + ' · ' + first.version + ' · 只读快照');
          } catch (error) {
            if (epoch === fileSeq && taskEpoch === generation) setStatus('文件读取失败：' + error.message);
          }
        }
        function renderFile() {
          if (!fileState) { srcPre.textContent = ''; pager.hidden = true; return; }
          meta.replaceChildren();
          for (const text of [fileState.path, 'version ' + fileState.version, fileState.lineCount + ' 行' + (fileState.eof ? '' : '（分页）')]) {
            const span = document.createElement('span'); span.textContent = text; meta.append(span);
          }
          srcPre.textContent = fileState.lines.map((line, i) => String(fileState.offset + i).padStart(4, ' ') + '  ' + line).join('\n');
          pager.hidden = fileState.eof && fileState.offset === 1;
          pager.replaceChildren();
          if (pager.hidden) return;
          const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'av-ghost'; prev.textContent = '上一页';
          prev.disabled = fileState.offset <= 1;
          const next = document.createElement('button'); next.type = 'button'; next.className = 'av-ghost'; next.textContent = fileState.eof ? '已到末尾' : '下一页';
          next.disabled = fileState.eof;
          const info = document.createElement('span'); info.textContent = '第 ' + fileState.offset + '–' + (fileState.offset + fileState.lines.length - 1) + ' 行';
          prev.addEventListener('click', () => pageFile(Math.max(1, fileState.offset - 400)));
          next.addEventListener('click', () => pageFile(fileState.offset + fileState.lines.length));
          pager.append(prev, info, next);
        }
        async function pageFile(offset) {
          const epoch = fileState.seq;
          try {
            const data = await read('tasks/' + enc(binding.workItemId) + '/files?' + new URLSearchParams({ path: fileState.path, offset, limit: 400 }));
            if (epoch !== fileState.seq) return;
            fileState = { ...data, seq: epoch };
            renderFile();
          } catch (error) { setStatus('分页读取失败：' + error.message); }
        }

        // ---- 选区引用 → 原生草稿（conversation.input.dock / inputActions）--
        quoteBtn.addEventListener('click', () => {
          if (!fileState || !binding.bindingId) return;
          if (!context || binding.workItemId !== context.workItemId) { setStatus('任务绑定已切换，引用已取消'); return; }
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) { setStatus('请先在源码区选择文本'); return; }
          const raw = srcPre.textContent;
          const start = Math.min(selection.anchorOffset, selection.focusOffset);
          const end = Math.max(selection.anchorOffset, selection.focusOffset);
          const startLine = fileState.offset - 1 + raw.slice(0, start).split('\n').length;
          const endLine = fileState.offset - 1 + raw.slice(0, Math.max(start, end - 1)).split('\n').length;
          const text = end > start ? raw.slice(start, end) : (fileState.lines[startLine - fileState.offset] || '');
          let quote;
          try { quote = bridge.referenceText({ path: fileState.path, startLine, endLine, version: fileState.version, text }); }
          catch (error) { setStatus(error.message); return; }
          const actions = dockActions.get(binding.sessionId);
          if (!actions) { setStatus('原生输入区尚未连接，请先在右侧选中本任务的工作会话'); return; }
          const span = actions.captureInsertion();
          const inserted = actions.insertText('\n' + quote + '\n', span);
          setStatus(inserted ? '选区引用已加入原生草稿（未发送）' : '原生草稿已变化，本次引用未插入');
        });

        // ---- Diff ---------------------------------------------------------
        async function loadDiff(force = false) {
          const epoch = generation;
          try {
            const headers = {};
            if (!force && diffCache.etag) headers['If-None-Match'] = diffCache.etag;
            const response = await fetch('/argon/vibe/tasks/' + enc(binding.workItemId) + '/diff', { cache: 'no-store', credentials: 'same-origin', headers });
            if (epoch !== generation) return;
            if (response.status === 304) return;
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || ('请求失败（HTTP ' + response.status + '）'));
            diffCache = { etag: response.headers.get('ETag'), body: data };
            renderTree(); // 变更文件并文件入左侧列表
            if (activeTab === 'diff') renderDiff();
          } catch (error) { if (epoch === generation) setStatus('Diff 读取失败：' + error.message); }
        }
        function renderDiff() {
          main.querySelectorAll('[data-av-warn]').forEach(n => n.remove());
          const body = diffCache.body;
          meta.replaceChildren();
          srcPre.textContent = '';
          pager.hidden = true;
          runBox.hidden = true; srcPre.hidden = false;
          if (!body) { meta.textContent = '正在读取差异…'; return; }
          for (const text of [
            '分支 ' + (body.branch || '—'), 'base ' + String(body.baseCommit || '—').slice(0, 12),
            'head ' + String(body.headCommit || '—').slice(0, 12),
            (body.changedFiles || []).length + ' 个变更文件',
            (body.testsChanged || []).length ? '测试已变更：' + body.testsChanged.join('、') : '测试未变更',
          ]) { const span = document.createElement('span'); span.textContent = text; meta.append(span); }
          srcPre.textContent = body.diff || '当前没有代码差异。';
          if (body.diffTruncated) {
            const warn = document.createElement('div');
            warn.className = 'av-warn';
            warn.dataset.avWarn = '1';
            warn.textContent = '差异内容已截断，仅展示前部片段；完整差异请在沙箱内用 git diff 查看。';
            main.insertBefore(warn, srcPre.nextSibling);
          }
        }

        // ---- 运行区（任务作用域挂载的 Run Monitor） -----------------------
        let monitorModule = null;
        async function ensureMonitor() {
          if (monitorModule) return monitorModule;
          try { monitorModule = await import(/* @vite-ignore */ MONITOR_URL); }
          catch (error) { setStatus('运行监控需要 argon-console 插件（' + error.message + '）'); }
          return monitorModule;
        }
        async function renderRun() {
          const mod = await ensureMonitor();
          if (!mod || !context) return;
          runBox.replaceChildren();
          const panel = mod.renderMonitor({
            workItemId: binding.workItemId,
            workflow: context.workflow || { phase: context.phase },
            operations: (context.operations || []).map(op => ({ operationId: op.operationId, status: op.state, kind: op.kind })),
            session: null,
            workItem: { paused: context.paused },
            el: (tag, attrs = {}) => {
              const node = document.createElement(tag);
              for (const [k, v] of Object.entries(attrs)) { if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node.setAttribute(k, v); }
              return node;
            },
            panelHead: (title, sub) => {
              const headEl = document.createElement('div'); headEl.className = 'panel-head';
              const h = document.createElement('h2'); h.textContent = title;
              const small = document.createElement('small'); small.textContent = sub || '';
              headEl.append(h, small); return headEl;
            },
            request: path => api(path),
            notice: setStatus,
            phaseText,
            opLabel,
          }, { container: runBox });
          runBox.append(panel);
        }

        function switchTab(key) {
          activeTab = key;
          for (const [k, btn] of Object.entries(tabButtons)) btn.setAttribute('aria-selected', String(k === key));
          root.querySelectorAll('[data-av-warn]').forEach(n => n.remove());
          srcPre.hidden = key === 'run';
          pager.hidden = key !== 'source' || !fileState || (fileState.eof && fileState.offset === 1);
          runBox.hidden = key !== 'run';
          if (key === 'diff') { if (diffCache.body) renderDiff(); else void loadDiff(); }
          if (key === 'run') void renderRun();
          if (key === 'source') renderFile();
        }

        // ---- 任务输入（主线 message 路由 + 服务端阶段守卫） ---------------
        async function sendMessage() {
          const text = input.value.trim();
          if (!text) return;
          if (!context || !binding.bindingId || binding.workItemId !== context.workItemId) { setStatus('任务绑定已切换，已取消发送'); return; }
          send.disabled = true;
          try {
            await api('/work-items/' + enc(binding.workItemId) + '/message', { method: 'POST', body: { text }, mutation: true });
            input.value = '';
            setStatus('补充说明已提交，等待工作流按当前阶段处理');
            await loadContext();
            if (activeTab === 'run') await renderRun();
          } catch (error) {
            setStatus(error.message); // 409 阶段守卫拒绝原因直接展示，不本地拦截
          } finally { send.disabled = false; }
        }
        send.addEventListener('click', sendMessage);
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void sendMessage(); } });

        // ---- 原生侧栏文件链接 → 中间代码区 --------------------------------
        function FileRoute(props) {
          const { tab } = props.useTabInfo();
          React.useEffect(() => {
            if (!tab.visible) return;
            const target = binding.sessionId && bridge.fileNavigation(tab.navigation.address, binding.sessionId, tab.navigation.params?.file || tab.navigation.params || {});
            if (target) { switchTab('source'); void openFile(target.path, target.line); }
            tab.actions.close();
          }, [tab.id, tab.visible, tab.navigation.revision]);
          return React.createElement('p', null, '在任务代码区打开文件…');
        }
        const fileDefinition = {
          id: '@local/argon-vibe/file', kind: 'argon-vibe-file', patterns: ['dsh-resource://file/**'], priority: 'extension',
          canOpen: address => !!(binding.sessionId && bridge.fileNavigation(address, binding.sessionId)),
          title: () => '任务代码区',
        };
        ctx.effect(() => ctx.sidebarRightTabs.register(fileDefinition));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: fileDefinition.id }, FileRoute));

        // ---- 原生输入区 dock：捕获 inputActions，展示绑定状态 ------------
        function VibeDock(props) {
          React.useEffect(() => {
            if (!binding.sessionId || props.sessionId !== binding.sessionId) return undefined;
            dockActions.set(props.sessionId, props.inputActions);
            return () => { if (dockActions.get(props.sessionId) === props.inputActions) dockActions.delete(props.sessionId); };
          }, [props.sessionId, props.inputActions]);
          return React.createElement('span', { title: 'Argon 任务代码区已连接此会话的输入区' }, '⚡ 任务代码区');
        }
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'argon-vibe-context', order: 0 }, VibeDock));

        // ---- 会话导航与生命周期 -------------------------------------------
        if (binding.sessionId) {
          ctx.effect(() => {
            let current = true;
            void bridge.openKnownSession(ctx.sessions, binding.sessionId, id => ctx.uiWorkspace.openSession(id), () => current)
              .catch(error => { if (current) setStatus('会话加载失败：' + error.message); });
            return () => { current = false; };
          });
        }
        ctx.effect(() => () => {
          clearInterval(refreshTimer);
          dockActions.clear();
          root.remove();
        });

        // ---- 启动 ----------------------------------------------------------
        await loadContext();
        await loadDiff();
      } catch (error) { console.error('argon-vibe client activation:', error); throw error; }
    },
  };
} });
