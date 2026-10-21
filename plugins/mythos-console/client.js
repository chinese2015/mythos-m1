window.__ModuleLoader__.load({ id: '@local/mythos-console', factory: () => ({
  inject: ['uiWorkspace', 'sessions'],
  apply(ctx) {
    try {
    const query = new URLSearchParams(location.search), sid = query.get('mythosSession');
    if (sid && /^session-[a-zA-Z0-9-]{1,140}$/.test(sid)) ctx.effect(() => {
      let opened = false, disposed = false, scheduled = false;
      const select = () => {
        scheduled = false;
        if (disposed || opened || !ctx.sessions.list.getSnapshot().byId[sid]) return;
        // Retention can synchronously publish the session catalog while openSession is on the stack.
        opened = true;
        try { ctx.uiWorkspace.openSession(sid); } catch (error) { opened = false; throw error; }
      };
      const schedule = () => {
        if (disposed || opened || scheduled) return;
        scheduled = true;
        // Native restore publishes retention before finishing its selection. Let that stack settle first.
        Promise.resolve().then(select).catch(error => console.error('mythos-console session navigation failed:', error));
      };
      const unsubscribe = ctx.sessions.list.subscribe(schedule); schedule();
      return () => { disposed = true; unsubscribe(); };
    });
    if (query.get('mythosEmbedded') !== '1') ctx.effect(() => {
      const link = document.createElement('a'); link.href = '/mythos/'; link.textContent = 'Task Workspace ↗';
      link.setAttribute('aria-label', 'Open the Mythos Task Workspace');
      Object.assign(link.style, { position: 'fixed', bottom: '12px', left: '12px', zIndex: '1000', background: '#2055d6', color: 'white', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', textDecoration: 'none' });
      document.body.append(link); return () => link.remove();
    });
    } catch (error) { console.error('mythos-console activation failed:', error); throw error; }
  },
}) });
