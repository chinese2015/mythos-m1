// Mythos Vibe 任务编码视图（dsh client plugin）。
// 外壳与原生会话各占独立网格，窄屏上下排列，避免遮挡原生客户端。
// 数据全部来自本插件 /mythos/vibe 只读路由；任务输入走主线
// POST /mythos/api/work-items/:id/message（服务端阶段守卫，409 原因直接展示）。
window.__ModuleLoader__.load({ id: '@local/mythos-vibe', factory: require => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useCodeHighlighter, languageForPath } = require('@deepseek-ai/dsh-client-ui-primitives');
  const BRIDGE_URL = window.__MYTHOS_VIBE_BRIDGE__ || '/mythos/vibe/bridge-browser.mjs';
  const MONITOR_URL = '/mythos/monitor-view.js';
  const PHASE_LABELS = {
    CLAIMED: 'Claimed', PREPARING: 'Preparing Workspace', BASELINE: 'Reproducing Baseline', PLANNING: 'Planning',
    AWAITING_PLAN_APPROVAL: 'Awaiting Plan Approval', CODING: 'Coding', VERIFYING: 'Independent Verification',
    AWAITING_REVIEW: 'Delivery & Review', PUBLISHING: 'Publishing', PR_OPEN: 'PR Open', CLOSING: 'Closing',
    COMPLETED: 'Completed', BLOCKED: 'Blocked',
  };
  const phaseText = phase => PHASE_LABELS[phase] ?? phase ?? '—';
  const opLabel = op => ({ BASELINE: 'Baseline Tests', VERIFY: 'Independent Verification', PLAN: 'Plan Generation', BUILD: 'Build Check' }[op?.kind] || op?.kind || 'Operation');

  return {
    inject: ['uiWorkspace', 'sessions', 'slots', 'conversation', 'sidebarRight', 'sidebarRightTabs'],
    async apply(ctx) {
      try {
        const query = new URLSearchParams(location.search);
        const workItemParam = query.get('mythosVibeTask');
        if (!workItemParam || !/^work-[a-zA-Z0-9-]{1,140}$/.test(workItemParam)) return; // 非任务编码窗口，静默不激活
        const bridge = await import(/* @vite-ignore */ BRIDGE_URL);

        // ---- 绑定与代次 --------------------------------------------------
        // binding 三键（workItemId/sessionId/bindingId）；bindingId 即 generation
        // 令牌：任务或会话切换后重新生成，所有迟到响应按代次丢弃。
        let generation = 0;
        let disposed = false;
        const binding = { workItemId: workItemParam, sessionId: query.get('mythosSession') || null, bindingId: '' };
        const rebind = () => { generation += 1; binding.bindingId = crypto.randomUUID(); };
        rebind();
        let context = null;   // /context 最近一次快照
        let fileState = null; // { path, version, offset, limit, lines, eof, lineCount, seq }
        let fileSeq = 0;
        let activeTab = 'source';
        let diffCache = { etag: null, body: null };
        let diffSeq = 0;
        let treeKey = null;
        const dockActions = new Map(); // sessionId -> 原生 inputActions
        let editorText = '';

        const enc = encodeURIComponent;
        const setStatus = text => { statusLine.textContent = text; statusLine.title = text; };

        async function read(route) {
          const response = await fetch('/mythos/vibe/' + route, { cache: 'no-store', credentials: 'same-origin' });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || ('Request failed (HTTP ' + response.status + ')'));
          return data;
        }
        async function api(path, { method = 'GET', body, mutation = false } = {}) {
          const headers = { Accept: 'application/json' };
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          if (mutation) { headers['X-Mythos-Action'] = '1'; headers['Idempotency-Key'] = crypto.randomUUID(); }
          const response = await fetch('/mythos/api' + path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const detail = data.error || data.message || data.detail;
            if (response.status === 401) throw new Error('Your login has expired. Please log in again in the DSH main window first.');
            throw new Error(detail ? String(detail) : ('Request failed (HTTP ' + response.status + ')'));
          }
          return data;
        }

        // ---- 外壳 DOM ----------------------------------------------------
        const style = document.createElement('style');
        style.textContent = `
body.av-layout{--av-bg:#fff;--av-side:#f6f8fa;--av-border:#d8dee4;--av-line:#eaeef2;--av-fg:#1f2328;--av-muted:#656d76;--av-blue:#0969da;--av-selected:#ddf4ff;--av-green:#1a7f37;display:grid;grid-template-columns:minmax(0,1.75fr) minmax(360px,1fr);grid-template-rows:44px minmax(0,1fr) 26px;height:100dvh;overflow:hidden}
body.av-layout>#root{box-sizing:border-box;grid-column:2;grid-row:2;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;border-left:1px solid var(--av-border)}
.av-root,.av-chrome,.av-statusbar{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;font-size:13px;color:var(--av-fg)}
.av-root,.av-root *,.av-chrome,.av-chrome *,.av-statusbar,.av-statusbar *{box-sizing:border-box}
.av-root [hidden]{display:none!important}.av-root{grid-column:1;grid-row:2;position:relative;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--av-bg);--shiki-foreground:var(--av-fg);--shiki-token-comment:#6e7781;--shiki-token-keyword:#cf222e;--shiki-token-string:#0a3069;--shiki-token-string-expression:#0a3069;--shiki-token-function:#8250df;--shiki-token-constant:#0550ae;--shiki-token-parameter:#953800}
.av-icon{width:16px;height:16px;flex:none;vertical-align:middle}.av-chrome{grid-column:1/-1;grid-row:1;display:flex;align-items:center;gap:20px;padding:0 16px;background:#24292f;color:#e6edf3;border-bottom:1px solid #171b20;min-width:0}
.av-brand{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:650;letter-spacing:-.5px}.av-brand .av-icon{color:#a5d6ff;width:20px;height:20px}.av-brand small{font-size:10px;letter-spacing:1.2px;font-weight:500;color:#8c959f;margin-left:6px}
.av-repository{display:flex;align-items:center;gap:8px;min-width:0;flex:1;color:#c9d1d9;font-size:12px}.av-repository-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.av-head{display:flex;align-items:center;gap:10px;min-width:0}.av-id{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#a4adb8;white-space:nowrap}.av-badge{font-size:10px;line-height:20px;padding:0 7px;border:1px solid #3fb95055;border-radius:4px;color:#7ee787;background:#23863626;white-space:nowrap}.av-version{display:none}.av-badge.av-blocked{background:#f8514926;color:#ffb4ab;border-color:#f8514955}.av-badge.av-paused{color:#e3b341;border-color:#e3b34155}
.av-banner{padding:7px 16px;font-size:12px;border-bottom:1px solid var(--av-border)}.av-banner.av-blocked{background:#ffebe9;color:#cf222e}.av-banner.av-paused{background:#fff8c5;color:#9a6700}
.av-row{flex:1;display:flex;min-width:0;min-height:0}.av-explorer{display:flex;flex-direction:column;flex:0 0 260px;min-width:0;min-height:0;border-right:1px solid var(--av-border);background:var(--av-side)}.av-explorer-head{height:40px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 16px;color:var(--av-muted);font-size:11px;letter-spacing:.4px}.av-count{min-width:18px;text-align:center;font:10px/18px ui-monospace,SFMono-Regular,Menlo,monospace;background:#afb8c126;border-radius:8px;color:var(--av-muted)}.av-explorer-repo{display:flex;align-items:center;gap:7px;height:31px;flex:none;padding:0 12px;font-size:11px;font-weight:600;overflow:hidden;white-space:nowrap}.av-explorer-repo span{overflow:hidden;text-overflow:ellipsis}.av-explorer-repo .av-icon{width:14px;height:14px;color:var(--av-muted)}
.av-tree{flex:1;min-height:0;overflow:auto;padding:2px 0 16px}.av-folder{margin:0 0 7px}.av-folder>summary{display:flex;align-items:center;gap:5px;padding:5px 12px;color:var(--av-muted);font:10px/18px ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;list-style:none;overflow:hidden;white-space:nowrap}.av-folder>summary::-webkit-details-marker{display:none}.av-folder>summary:before{content:"›";font-size:15px;line-height:14px;transform:rotate(90deg);transition:transform .1s}.av-folder:not([open])>summary:before{transform:rotate(0)}.av-folder>summary span{overflow:hidden;text-overflow:ellipsis}.av-folder>summary .av-icon{width:13px;height:13px;color:#7d8590}
.av-file{position:relative;display:flex;align-items:center;gap:7px;width:100%;padding:6px 12px 6px 24px;text-align:left;border:0;background:transparent;color:var(--av-fg);font-size:11px;line-height:18px;cursor:pointer}.av-file:hover{background:#afb8c11a}.av-file[aria-current="true"]{background:var(--av-selected);box-shadow:inset 2px 0 var(--av-blue)}.av-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.av-file .av-icon{width:14px;height:14px;color:#9a6700}.av-file-change{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--av-green)}.av-tree-empty{padding:14px 16px;color:var(--av-muted);font-size:12px;line-height:1.7}
.av-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}.av-tabs{display:flex;align-items:center;height:40px;flex:none;padding:0 10px;background:var(--av-side);border-bottom:1px solid var(--av-border);gap:2px}.av-tab{height:40px;padding:0 13px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--av-muted);font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:7px;cursor:pointer}.av-tab .av-icon{width:14px;height:14px}.av-tab:hover{color:var(--av-fg)}.av-tab[aria-selected="true"]{border-bottom-color:var(--av-blue);color:var(--av-fg);background:var(--av-bg)}.av-quote{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:11px!important}.av-root button.av-ghost{border:1px solid var(--av-border);border-radius:5px;background:var(--av-bg);padding:4px 8px;color:var(--av-muted);cursor:pointer}.av-root button.av-ghost:hover:enabled{color:var(--av-blue);border-color:var(--av-blue)}.av-root button:disabled{opacity:.4;cursor:default}.av-root button:focus-visible,.av-folder>summary:focus-visible{outline:2px solid var(--av-blue);outline-offset:-2px}
.av-editor-title{display:flex;align-items:center;gap:8px;flex:none;height:35px;padding:0 16px;border-bottom:1px solid var(--av-line);font-size:12px;background:var(--av-bg)}.av-editor-title>.av-icon{width:14px;height:14px;color:#9a6700}.av-active-file{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.av-snapshot{display:flex;align-items:center;gap:4px;margin-left:auto;color:var(--av-muted);font-size:10px;white-space:nowrap}.av-snapshot .av-icon{width:12px;height:12px}.av-meta{display:flex;align-items:center;gap:12px;height:29px;flex:none;overflow:hidden;padding:0 16px;color:var(--av-muted);font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-overflow:ellipsis;border-bottom:1px solid var(--av-line)}.av-meta span{white-space:nowrap;flex:none}.av-meta span:last-child{overflow:hidden;text-overflow:ellipsis}
.av-src{flex:1;min-width:0;min-height:0;overflow:auto;margin:0;padding:10px 0 18px;white-space:pre;background:var(--av-bg);color:var(--av-fg);font:12px/21px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}.av-code-line{display:block;min-width:max-content;height:21px;line-height:21px;padding-right:24px}.av-code-line:before{content:attr(data-line);display:inline-block;width:54px;text-align:right;padding-right:18px;color:#8c959f;user-select:none;position:sticky;left:0;background:var(--av-bg);font-size:11px}.av-code-line:hover{background:#f6f8fa}.av-code-line.av-diff-add,.av-code-line.av-diff-add:before{background:#dafbe1}.av-code-line.av-diff-remove,.av-code-line.av-diff-remove:before{background:#ffebe9}.av-code-line.av-diff-hunk,.av-code-line.av-diff-hunk:before{background:#ddf4ff;color:#0969da}.av-code-line.av-diff-file{font-weight:600;color:#0550ae}.av-pager{padding:6px 16px;border-top:1px solid var(--av-border);display:flex;gap:8px;align-items:center;font-size:11px}.av-warn{margin:8px 16px;padding:8px 10px;background:#fff8c5;color:#9a6700;border-radius:5px;font-size:11px}
.av-foot{display:flex;align-items:center;gap:8px;flex:none;padding:9px 12px;border-top:1px solid var(--av-border);background:var(--av-side)}.av-foot>.av-icon{color:var(--av-muted);width:15px;height:15px}.av-foot input{flex:1;min-width:0;width:0;height:32px;border:1px solid var(--av-border);border-radius:5px;background:var(--av-bg);padding:6px 10px;color:var(--av-fg);font:inherit;font-size:12px;outline:none}.av-foot input::placeholder{color:#8c959f}.av-foot input:focus{border-color:var(--av-blue);box-shadow:0 0 0 2px #0969da15}.av-foot button{display:flex;align-items:center;justify-content:center;gap:6px;height:30px;flex:none;border:1px solid #075fc5;border-radius:5px;background:var(--av-blue);color:white;padding:0 10px;cursor:pointer;font-size:11px}.av-foot button .av-icon{width:13px;height:13px}
.av-statusbar{grid-column:1/-1;grid-row:3;display:flex;align-items:center;min-width:0;height:26px;background:var(--av-side);border-top:1px solid var(--av-border);color:var(--av-muted);font-size:10px;gap:16px}.av-env{display:flex;align-items:center;gap:6px;padding:0 12px;align-self:stretch;background:var(--av-blue);color:white;white-space:nowrap}.av-env .av-icon{width:13px;height:13px}.av-branch{display:flex;align-items:center;gap:6px;max-width:260px;min-width:0;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.av-branch span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.av-branch .av-icon{width:12px;height:12px}.av-status{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}.av-editor-info{display:flex;align-items:center;gap:14px;padding-right:14px;white-space:nowrap}.av-editor-info .av-icon{width:11px;height:11px}.av-mode{display:flex;align-items:center;gap:4px}.av-dock{display:inline-flex;align-items:center;gap:5px;color:#656d76;font-size:10px}.av-dock:before{content:"";width:5px;height:5px;border-radius:50%;background:#1a7f37}
.av-run{flex:1;min-height:0;overflow:auto;padding:20px;background:var(--av-bg)}.av-run .panel-head{padding-bottom:16px;border-bottom:1px solid var(--av-line);margin-bottom:12px}.av-run h2{font-size:14px;font-weight:600;margin:0 0 5px}.av-run .panel-head small,.av-run .subtle{font-size:11px;color:var(--av-muted)}.av-run .operation{padding:12px 14px;margin:8px 0;border:1px solid var(--av-border);border-radius:6px;background:var(--av-bg)}.av-run .operation-top{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px;font-weight:600}.av-run .operation-status{font-size:10px;border-radius:10px;padding:2px 8px;background:var(--av-side)}.av-run .operation-status.succeeded{background:#dafbe1;color:#1a7f37}.av-run .operation-status.failed{background:#ffebe9;color:#cf222e}.av-run .operation-details{display:flex;flex-wrap:wrap;gap:5px 12px;color:var(--av-muted);font-size:10px;margin:8px 0;overflow-wrap:anywhere}.av-run .event-stream,.av-run .log-box{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}.av-run .event-stream{padding:12px;border:1px solid var(--av-border);border-radius:5px;background:var(--av-side)}.av-run .log-box{max-height:260px;overflow:auto;padding:10px;margin-top:10px;background:var(--av-side);border-radius:4px}.av-run .monitor-divider{font-size:11px;font-weight:600;margin:20px 0 10px}.av-run .text-button{border:1px solid var(--av-border);border-radius:4px;background:var(--av-side);color:var(--av-blue);cursor:pointer;padding:3px 8px;font-size:10px}
@media(max-width:1100px){body.av-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:44px minmax(0,54fr) minmax(0,46fr) 26px}body.av-layout>#root{grid-column:1;grid-row:3;border-left:0;border-top:1px solid var(--av-border)}.av-statusbar{grid-row:4}}
@media(max-width:650px){.av-chrome{gap:12px;padding:0 12px}.av-brand small,.av-id,.av-snapshot,.av-branch{display:none}.av-brand{font-size:15px}.av-repository{font-size:11px}.av-row{flex-direction:column}.av-explorer{flex:0 0 auto;border-right:0;border-bottom:1px solid var(--av-border)}.av-explorer-head,.av-explorer-repo,.av-folder>summary{display:none}.av-tree{display:flex;overflow:auto;padding:0}.av-folder{display:contents}.av-file{width:auto;flex:none;padding:7px 12px;border-right:1px solid var(--av-line)}.av-file-name{max-width:180px}.av-file[aria-current="true"]{box-shadow:inset 0 -2px var(--av-blue)}.av-tabs{padding:0 4px}.av-tab{padding:0 10px}.av-tab .av-icon{display:none}.av-quote{font-size:10px!important}.av-quote .av-icon{display:none}.av-editor-title{height:30px;padding:0 12px}.av-meta{height:25px;padding:0 12px}.av-code-line:before{width:42px;padding-right:14px}.av-statusbar{gap:10px}.av-editor-info{gap:10px;padding-right:8px}.av-env{padding:0 8px}.av-run{padding:12px}}
body[data-ds-dark-theme].av-layout{--av-bg:#0d1117;--av-side:#161b22;--av-border:#30363d;--av-line:#21262d;--av-fg:#e6edf3;--av-muted:#8b949e;--av-blue:#58a6ff;--av-selected:#1f6feb26;--av-green:#3fb950}body[data-ds-dark-theme] .av-root{--shiki-token-comment:#8b949e;--shiki-token-keyword:#ff7b72;--shiki-token-string:#a5d6ff;--shiki-token-string-expression:#a5d6ff;--shiki-token-function:#d2a8ff;--shiki-token-constant:#79c0ff;--shiki-token-parameter:#ffa657}body[data-ds-dark-theme] .av-code-line:hover{background:#161b22}body[data-ds-dark-theme] .av-code-line.av-diff-add,body[data-ds-dark-theme] .av-code-line.av-diff-add:before{background:#12261e}body[data-ds-dark-theme] .av-code-line.av-diff-remove,body[data-ds-dark-theme] .av-code-line.av-diff-remove:before{background:#31191c}body[data-ds-dark-theme] .av-code-line.av-diff-hunk,body[data-ds-dark-theme] .av-code-line.av-diff-hunk:before{background:#152438;color:#79c0ff}
        `;
        const element = (tag, className, text) => {
          const node = document.createElement(tag);
          if (className) node.className = className;
          if (text !== undefined) node.textContent = text;
          return node;
        };
        const iconPaths = {
          code: ['m5 5-4 3 4 3m6-6 4 3-4 3m-2-9-2 12'],
          repo: ['M3 1.5h9.5v13H3a1.5 1.5 0 0 1 0-3h9.5M3 1.5A1.5 1.5 0 0 0 1.5 3v10M5 4h5M5 6.5h4'],
          file: ['M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 10.5h4'],
          folder: ['M1.5 4h5l1.5 2h6.5v7h-13zM1.5 4V2.5h5l1.5 2h6.5V6'],
          diff: ['M4 1v9m0 0L1.5 7.5M4 10l2.5-2.5M12 15V6m0 0L9.5 8.5M12 6l2.5 2.5'],
          terminal: ['M1.5 2.5h13v11h-13zM4 6l2 2-2 2m4 0h3'],
          quote: ['M2 3h12v8H6l-3.5 3v-3H2zM5 6h6M5 8h4'],
          lock: ['M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3zM8 10v1.5'],
          branch: ['M4 4.5v7M12 4.5v2A3 3 0 0 1 9 9H7M6 2.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0m0 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0m8-11a2 2 0 1 1-4 0 2 2 0 0 1 4 0'],
          cloud: ['M4 12a3 3 0 1 1 0-6 4 4 0 0 1 7.7-1A3.5 3.5 0 1 1 12 12H4'],
          send: ['m2 8 12-6-4 12-2-6-6 0zM8 8l6-6'],
        };
        const icon = name => {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          for (const [key, value] of Object.entries({ class: 'av-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
          for (const d of iconPaths[name] || iconPaths.file) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
          }
          return svg;
        };
        const root = document.createElement('section');
        root.className = 'av-root';
        root.setAttribute('aria-label', 'Mythos Task Coding View');
        const head = document.createElement('div'); head.className = 'av-head';
        const idSpan = document.createElement('span'); idSpan.className = 'av-id';
        const phaseBadge = document.createElement('span'); phaseBadge.className = 'av-badge';
        const versionBadge = document.createElement('span'); versionBadge.className = 'av-badge av-version';
        head.append(idSpan, phaseBadge, versionBadge);
        const chrome = element('header', 'av-chrome');
        const brand = element('div', 'av-brand');
        brand.append(icon('code'), element('span', '', 'mythos'), element('small', '', 'WORKSPACE'));
        const repository = element('div', 'av-repository');
        const repositoryName = element('span', 'av-repository-name', 'Task workspace');
        repository.append(icon('repo'), repositoryName);
        chrome.append(brand, repository, head);
        const banner = document.createElement('div'); banner.className = 'av-banner'; banner.hidden = true;
        const tabsBar = document.createElement('div'); tabsBar.className = 'av-tabs';
        tabsBar.setAttribute('role', 'tablist'); tabsBar.setAttribute('aria-label', 'Code view');
        const tabDefs = [['source', 'Source', 'code'], ['diff', 'Diff', 'diff'], ['run', 'Run', 'terminal']];
        const tabButtons = {};
        for (const [key, label, glyph] of tabDefs) {
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'av-tab'; btn.append(icon(glyph), element('span', '', label)); btn.setAttribute('aria-selected', String(key === activeTab));
          btn.setAttribute('role', 'tab');
          btn.setAttribute('aria-label', label);
          btn.addEventListener('click', () => switchTab(key));
          tabButtons[key] = btn; tabsBar.append(btn);
        }
        const quoteBtn = document.createElement('button');
        quoteBtn.type = 'button'; quoteBtn.className = 'av-ghost av-quote'; quoteBtn.append(icon('quote'), element('span', '', 'Quote Selection')); quoteBtn.title = 'Insert the source selection into the native draft as a read-only snapshot';
        quoteBtn.disabled = true;
        tabsBar.append(quoteBtn);
        const row = document.createElement('div'); row.className = 'av-row';
        const explorer = element('aside', 'av-explorer');
        const explorerHead = element('div', 'av-explorer-head');
        const fileCount = element('span', 'av-count', '0');
        explorerHead.append(element('span', '', 'Explorer'), fileCount);
        const explorerRepo = element('div', 'av-explorer-repo');
        const explorerRepoName = element('span', '', 'Workspace');
        explorerRepo.append(icon('repo'), explorerRepoName);
        const tree = document.createElement('nav'); tree.className = 'av-tree';
        tree.setAttribute('aria-label', 'Workspace files');
        const fileLayout = window.matchMedia?.('(max-width:650px)');
        const showNarrowFiles = () => {
          if (fileLayout?.matches) for (const group of tree.querySelectorAll('details')) group.open = true;
        };
        ctx.effect(() => {
          fileLayout?.addEventListener('change', showNarrowFiles);
          return () => fileLayout?.removeEventListener('change', showNarrowFiles);
        });
        explorer.append(explorerHead, explorerRepo, tree);
        const main = document.createElement('div'); main.className = 'av-main';
        const editorTitle = element('div', 'av-editor-title');
        const activeFile = element('span', 'av-active-file', 'Select a file');
        const snapshot = element('span', 'av-snapshot');
        snapshot.append(icon('lock'), element('span', '', 'Read-only snapshot'));
        editorTitle.append(icon('file'), activeFile, snapshot);
        const meta = document.createElement('div'); meta.className = 'av-meta';
        const srcPre = document.createElement('pre'); srcPre.className = 'av-src';
        const codeRoot = typeof createRoot === 'function' && typeof useCodeHighlighter === 'function' ? createRoot(srcPre) : null;
        function CodeLines({ text, path, offset, mode, scrollLine }) {
          const language = mode === 'diff' ? 'diff' : languageForPath(path);
          const highlight = useCodeHighlighter(language);
          const lines = text.split('\n'), tokens = highlight(text);
          React.useLayoutEffect(() => {
            if (disposed || mode !== 'source' || scrollLine === null) return;
            const row = srcPre.querySelector('.av-code-line')?.getBoundingClientRect?.();
            srcPre.scrollTop = Math.max(0, scrollLine - offset - 3) * (row?.height || 21);
          }, [text, path, offset, mode, scrollLine]);
          return React.createElement(React.Fragment, null, ...lines.map((line, index) => {
            let spans = tokens?.[index] || [{ text: line }];
            const rendered = spans.map(token => token.text).join('');
            // Some grammars normalize CRLF; DOM offsets must still match the snapshot.
            if (rendered !== line) spans = line === rendered + '\r' ? [...spans, { text: '\r' }] : [{ text: line }];
            const tone = mode !== 'diff' ? '' : line.startsWith('@@') ? ' av-diff-hunk'
              : line.startsWith('diff --git') ? ' av-diff-file'
              : line.startsWith('+') && !line.startsWith('+++') ? ' av-diff-add'
              : line.startsWith('-') && !line.startsWith('---') ? ' av-diff-remove' : '';
            return React.createElement('span', { key: index, className: 'av-code-line' + tone, 'data-line': mode === 'diff' ? '' : offset + index },
              ...spans.map((token, key) => React.createElement('span', { key, style: token.style }, token.text)),
              index < lines.length - 1 ? '\n' : '');
          }));
        }
        function renderCode(text, path = '', offset = 1, mode = 'source', scrollLine = null) {
          if (disposed) return;
          editorText = text;
          if (codeRoot) codeRoot.render(text ? React.createElement(CodeLines, { text, path, offset, mode, scrollLine }) : null);
          else {
            srcPre.textContent = text;
            if (scrollLine !== null) srcPre.scrollTop = Math.max(0, scrollLine - offset - 3) * 21;
          }
        }
        const pager = document.createElement('div'); pager.className = 'av-pager'; pager.hidden = true;
        const runBox = document.createElement('div'); runBox.className = 'av-run'; runBox.hidden = true;
        main.append(tabsBar, editorTitle, meta, srcPre, pager, runBox);
        row.append(explorer, main);
        const foot = document.createElement('div'); foot.className = 'av-foot';
        const input = document.createElement('input');
        input.placeholder = 'Send additional instructions to the current workflow (phase-guarded by the server)…';
        input.setAttribute('aria-label', 'Additional instructions');
        const send = document.createElement('button'); send.type = 'button'; send.append(element('span', '', 'Send'), icon('send'));
        send.setAttribute('aria-label', 'Send additional instructions');
        foot.append(icon('quote'), input, send);
        const statusbar = element('footer', 'av-statusbar');
        const environment = element('span', 'av-env'); environment.append(icon('cloud'), element('span', '', 'Sandbox workspace'));
        const branch = element('span', 'av-branch'), branchName = element('span', '', 'Awaiting repository');
        branch.append(icon('branch'), branchName);
        const statusLine = element('span', 'av-status', 'Connecting to workspace…');
        statusLine.setAttribute('role', 'status');
        const editorInfo = element('div', 'av-editor-info');
        const modeLabel = element('span', 'av-mode'); modeLabel.append(icon('lock'), element('span', '', 'Read-only'));
        const languageLabel = element('span', '', 'Plain text'), linesLabel = element('span', '', '');
        editorInfo.append(modeLabel, languageLabel, linesLabel);
        statusbar.append(environment, branch, statusLine, editorInfo);
        root.append(style, banner, row, foot);
        document.body.classList.add('av-layout');
        document.body.append(chrome, root, statusbar);

        // ---- 上下文轮询与状态同步 ----------------------------------------
        function applyContext(next) {
          context = next;
          idSpan.textContent = next.source?.id || next.workItemId;
          idSpan.title = next.workItemId;
          let repoName = 'Task workspace';
          try { repoName = new URL(next.source.repositoryUrl).pathname.replace(/\.git$/, '').split('/').filter(Boolean).slice(-2).join('/') || repoName; } catch {}
          repositoryName.textContent = repoName;
          repository.title = next.source?.title || repoName;
          explorerRepoName.textContent = repoName.split('/').pop();
          explorerRepo.title = repoName;
          phaseBadge.textContent = phaseText(next.phase);
          phaseBadge.classList.toggle('av-blocked', !!next.blocked);
          phaseBadge.classList.toggle('av-paused', !!next.paused && !next.blocked);
          versionBadge.textContent = 'version ' + next.version;
          const notes = [];
          if (next.blocked) { banner.hidden = false; banner.className = 'av-banner av-blocked'; banner.textContent = 'Blocked' + (next.reason ? ': ' + next.reason : ''); }
          else if (next.paused) { banner.hidden = false; banner.className = 'av-banner av-paused'; banner.textContent = 'Workflow paused. Input will be queued and handled by the workflow after it resumes.'; }
          else banner.hidden = true;
          head.classList.toggle('av-paused', !!next.paused);
          quoteBtn.disabled = activeTab !== 'source' || !fileState;
          renderTree();
          if (activeTab === 'run') renderRun();
          return notes;
        }
        async function loadContext() {
          if (disposed) return;
          const epoch = generation;
          try {
            const data = await read('tasks/' + enc(binding.workItemId) + '/context');
            if (epoch !== generation) return; // 迟到响应：绑定已切换，丢弃
            if (!binding.sessionId) {
              const sid = data.codeSessionId || data.planSessionId || null;
              if (sid) { binding.sessionId = sid; rebind(); } // 会话晚绑定，旧代次响应全部作废
            }
            applyContext(data);
            setStatus('Context synced · version ' + data.version + (data.paused ? ' · Paused' : '') + (data.blocked ? ' · Blocked' : ''));
          } catch (error) {
            if (epoch === generation) setStatus('Failed to load context: ' + error.message);
          }
        }
        const refreshTimer = setInterval(() => { if (!document.hidden) { void loadContext(); void loadDiff(); if (activeTab === 'run') renderRun(); } }, 2000);

        // ---- 文件列表与只读源码 ------------------------------------------
        function knownFiles() {
          const files = [];
          const push = p => { if (typeof p === 'string' && p && !files.includes(p)) files.push(p); };
          push(context?.source?.sourcePath);
          for (const f of diffCache.body?.changedFiles || []) push(f);
          return files;
        }
        function renderTree() {
          const files = knownFiles();
          const nextKey = JSON.stringify([files, fileState?.path, diffCache.body?.changedFiles]);
          if (treeKey === nextKey) return; // 轮询不卸载相同按钮，保留键盘焦点。
          treeKey = nextKey;
          tree.replaceChildren();
          fileCount.textContent = String(files.length);
          if (!files.length) { const empty = document.createElement('div'); empty.className = 'av-tree-empty'; empty.textContent = 'No known files yet; open one from a file link in the native sidebar.'; tree.append(empty); return; }
          const groups = new Map();
          for (const path of files) {
            const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'Workspace';
            if (!groups.has(directory)) {
              const group = element('details', 'av-folder'); group.setAttribute('open', '');
              const summary = element('summary');
              const label = element('span', '', directory);
              summary.append(icon('folder'), label); summary.title = directory;
              group.append(summary); groups.set(directory, group); tree.append(group);
            }
            const btn = document.createElement('button');
            btn.type = 'button'; btn.className = 'av-file'; btn.title = path;
            btn.setAttribute('aria-label', path);
            btn.append(icon('file'), element('span', 'av-file-name', path.split('/').pop()));
            if (diffCache.body?.changedFiles?.includes(path)) btn.append(element('span', 'av-file-change', 'M'));
            btn.setAttribute('aria-current', String(fileState?.path === path));
            btn.addEventListener('click', () => openFile(path));
            groups.get(directory).append(btn);
          }
          showNarrowFiles();
        }
        async function openFile(path, line = 1) {
          if (disposed) return;
          const epoch = ++fileSeq;
          const taskEpoch = generation;
          fileState = null;
          switchTab('source');
          meta.textContent = 'Reading ' + path + '…';
          try {
            const first = await read('tasks/' + enc(binding.workItemId) + '/files?' + new URLSearchParams({ path, offset: 1, limit: 400 }));
            if (epoch !== fileSeq || taskEpoch !== generation) return;
            fileState = { ...first, seq: epoch };
            quoteBtn.disabled = activeTab !== 'source';
            if (activeTab === 'source') {
              renderFile(line);
            }
            renderTree();
            setStatus('Snapshot ready · ' + path.split('/').pop());
          } catch (error) {
            if (epoch === fileSeq && taskEpoch === generation) setStatus('Failed to read file: ' + error.message);
          }
        }
        function renderFile(scrollLine = null) {
          if (!fileState) {
            activeFile.textContent = 'Select a file'; meta.textContent = 'Open a file from the explorer';
            languageLabel.textContent = 'Plain text'; linesLabel.textContent = '';
            renderCode(''); pager.hidden = true; return;
          }
          activeFile.textContent = fileState.path.split('/').pop(); activeFile.title = fileState.path;
          meta.textContent = fileState.path.split('/').join('  ›  '); meta.title = fileState.path;
          snapshot.title = 'File version ' + fileState.version;
          const language = typeof languageForPath === 'function' ? languageForPath(fileState.path) : fileState.path.split('.').pop();
          languageLabel.textContent = language ? language[0].toUpperCase() + language.slice(1) : 'Plain text';
          linesLabel.textContent = fileState.lineCount + ' lines';
          renderCode(fileState.lines.join('\n'), fileState.path, fileState.offset, 'source', scrollLine);
          pager.hidden = fileState.eof && fileState.offset === 1;
          pager.replaceChildren();
          if (pager.hidden) return;
          const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'av-ghost'; prev.textContent = 'Previous page';
          prev.disabled = fileState.offset <= 1;
          const next = document.createElement('button'); next.type = 'button'; next.className = 'av-ghost'; next.textContent = fileState.eof ? 'End reached' : 'Next page';
          next.disabled = fileState.eof;
          const info = document.createElement('span'); info.textContent = 'Lines ' + fileState.offset + '–' + (fileState.offset + fileState.lines.length - 1);
          prev.addEventListener('click', () => pageFile(Math.max(1, fileState.offset - 400)));
          next.addEventListener('click', () => pageFile(fileState.offset + fileState.lines.length));
          pager.append(prev, info, next);
        }
        async function pageFile(offset) {
          const epoch = fileState.seq;
          try {
            const data = await read('tasks/' + enc(binding.workItemId) + '/files?' + new URLSearchParams({ path: fileState.path, offset, limit: 400 }));
            if (epoch !== fileState?.seq) return;
            fileState = { ...data, seq: epoch };
            if (activeTab === 'source') renderFile(fileState.offset);
          } catch (error) { setStatus('Failed to read page: ' + error.message); }
        }

        // ---- 选区引用 → 原生草稿（conversation.input.dock / inputActions）--
        quoteBtn.addEventListener('mousedown', event => event.preventDefault());
        quoteBtn.addEventListener('click', () => {
          if (!fileState || !binding.bindingId) return;
          if (!context || binding.workItemId !== context.workItemId) { setStatus('Task binding changed; quote cancelled'); return; }
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) { setStatus('Select text in the source view first'); return; }
          const range = selection.getRangeAt(0);
          if (!srcPre.contains(range.startContainer) || !srcPre.contains(range.endContainer)) { setStatus('Select the code to quote inside the source area'); return; }
          const prefix = document.createRange();
          prefix.selectNodeContents(srcPre);
          prefix.setEnd(range.startContainer, range.startOffset); const start = prefix.toString().length;
          prefix.setEnd(range.endContainer, range.endOffset); const end = prefix.toString().length;
          let quote;
          try { quote = bridge.referenceFromOffsets({ path: fileState.path, offset: fileState.offset, version: fileState.version, source: editorText, start, end }); }
          catch (error) { setStatus(error.message); return; }
          const actions = dockActions.get(binding.sessionId);
          if (!actions) { setStatus('Native input area not connected. Select this task’s work session on the right first.'); return; }
          const span = actions.captureInsertion();
          const inserted = actions.insertText('\n' + quote + '\n', span);
          setStatus(inserted ? 'Selection quoted into the native draft (not sent)' : 'Native draft changed; quote not inserted');
        });

        // ---- Diff ---------------------------------------------------------
        async function loadDiff(force = false) {
          if (disposed) return;
          const epoch = generation;
          const requestSeq = ++diffSeq;
          try {
            const headers = {};
            if (!force && diffCache.etag) headers['If-None-Match'] = diffCache.etag;
            const response = await fetch('/mythos/vibe/tasks/' + enc(binding.workItemId) + '/diff', { cache: 'no-store', credentials: 'same-origin', headers });
            if (epoch !== generation || requestSeq !== diffSeq) return;
            if (response.status === 304) return;
            const data = await response.json().catch(() => ({}));
            if (epoch !== generation || requestSeq !== diffSeq) return;
            if (!response.ok) throw new Error(data.error || ('Request failed (HTTP ' + response.status + ')'));
            diffCache = { etag: response.headers.get('ETag'), body: data };
            branchName.textContent = data.branch || 'Branch not bound'; branchName.title = data.branch || '';
            renderTree(); // 变更文件并文件入左侧列表
            if (activeTab === 'diff') renderDiff();
          } catch (error) { if (epoch === generation) setStatus('Failed to load diff: ' + error.message); }
        }
        function renderDiff() {
          main.querySelectorAll('[data-av-warn]').forEach(n => n.remove());
          const body = diffCache.body;
          meta.replaceChildren();
          activeFile.textContent = 'Workspace changes';
          languageLabel.textContent = 'Diff'; linesLabel.textContent = (body?.changedFiles || []).length + ' files';
          renderCode('');
          pager.hidden = true;
          runBox.hidden = true; srcPre.hidden = false;
          if (!body) { meta.textContent = 'Loading diff…'; return; }
          for (const text of [
            'branch ' + (body.branch || '—'), 'base ' + String(body.baseCommit || '—').slice(0, 12),
            'head ' + String(body.headCommit || '—').slice(0, 12),
            (body.changedFiles || []).length + ' changed files',
            (body.testsChanged || []).length ? 'Tests changed: ' + body.testsChanged.join(', ') : 'Tests unchanged',
          ]) { const span = document.createElement('span'); span.textContent = text; meta.append(span); }
          renderCode(body.diff || 'No code changes yet.', '', 1, 'diff');
          if (body.diffTruncated) {
            const warn = document.createElement('div');
            warn.className = 'av-warn';
            warn.dataset.avWarn = '1';
            warn.textContent = 'Diff truncated, showing only the beginning; view the full diff with git diff inside the sandbox.';
            main.insertBefore(warn, srcPre.nextSibling);
          }
        }

        // ---- 运行区（任务作用域挂载的 Run Monitor） -----------------------
        let monitorModule = null;
        async function ensureMonitor() {
          if (monitorModule) return monitorModule;
          try { monitorModule = await import(/* @vite-ignore */ MONITOR_URL); }
          catch (error) { setStatus('Run monitor requires the mythos-console plugin (' + error.message + ')'); }
          return monitorModule;
        }
        async function renderRun() {
          const mod = await ensureMonitor();
          if (disposed || !mod || !context || activeTab !== 'run') return;
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
          if (disposed) return;
          activeTab = key;
          for (const [k, btn] of Object.entries(tabButtons)) btn.setAttribute('aria-selected', String(k === key));
          quoteBtn.disabled = key !== 'source' || !fileState;
          root.querySelectorAll('[data-av-warn]').forEach(n => n.remove());
          srcPre.hidden = key === 'run';
          pager.hidden = key !== 'source' || !fileState || (fileState.eof && fileState.offset === 1);
          runBox.hidden = key !== 'run';
          snapshot.hidden = key !== 'source';
          if (key === 'diff') { if (diffCache.body) renderDiff(); else void loadDiff(); }
          if (key === 'run') void renderRun();
          if (key === 'run') { meta.textContent = 'Operation log & execution output'; activeFile.textContent = 'Run monitor'; languageLabel.textContent = 'Run log'; linesLabel.textContent = ''; }
          if (key === 'source') renderFile();
        }

        // ---- 任务输入（主线 message 路由 + 服务端阶段守卫） ---------------
        async function sendMessage() {
          const text = input.value.trim();
          if (!text) return;
          if (!context || !binding.bindingId || binding.workItemId !== context.workItemId) { setStatus('Task binding changed; send cancelled'); return; }
          send.disabled = true;
          try {
            await api('/work-items/' + enc(binding.workItemId) + '/message', { method: 'POST', body: { text }, mutation: true });
            input.value = '';
            setStatus('Instructions submitted; the workflow will handle them for the current phase');
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
          return React.createElement('p', null, 'Opening file in the task code view…');
        }
        const fileDefinition = {
          id: '@local/mythos-vibe/file', kind: 'mythos-vibe-file', patterns: ['dsh-resource://file/**'], priority: 'extension',
          canOpen: address => !!(binding.sessionId && bridge.fileNavigation(address, binding.sessionId)),
          title: () => 'Task Code View',
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
          return React.createElement('span', { className: 'av-dock', title: 'Mythos task code view connected to this session’s input area' }, 'Code context connected');
        }
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'mythos-vibe-context', order: 0 }, VibeDock));

        // ---- 会话导航与生命周期 -------------------------------------------
        if (binding.sessionId) {
          ctx.effect(() => {
            let current = true;
            void bridge.openKnownSession(ctx.sessions, binding.sessionId, id => ctx.uiWorkspace.openSession(id), () => current)
              .catch(error => { if (current) setStatus('Failed to load session: ' + error.message); });
            return () => { current = false; };
          });
        }
        ctx.effect(() => () => {
          disposed = true;
          generation += 1;
          fileSeq += 1;
          diffSeq += 1;
          clearInterval(refreshTimer);
          dockActions.clear();
          codeRoot?.unmount();
          root.remove();
          chrome.remove();
          statusbar.remove();
          document.body.classList.remove('av-layout');
        });

        // ---- 启动 ----------------------------------------------------------
        renderFile();
        await loadContext();
        if (disposed) return;
        await loadDiff();
        if (!disposed && activeTab === 'source' && fileSeq === 0 && knownFiles().length) await openFile(knownFiles()[0]);
      } catch (error) { console.error('mythos-vibe client activation:', error); throw error; }
    },
  };
} });
