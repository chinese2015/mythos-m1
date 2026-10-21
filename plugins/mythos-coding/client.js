window.__ModuleLoader__.load({ id:'@local/mythos-coding', factory:require=>{
  const React=require('react');
  return { inject:['uiWorkspace','sessions','slots','sidebarRight','sidebarRightTabs'], async apply(ctx){
    const query=new URLSearchParams(location.search), workItemId=query.get('mythosCodingWork');
    if(!/^work-[a-f0-9]{32}$/.test(workItemId??''))return;
    const {acceptMessage,fileNavigation,openKnownSession}=await import('/mythos/coding/bridge.js');
    const response=await fetch('/mythos/coding/api/work-items/'+workItemId+'/context',{cache:'no-store'});
    if(!response.ok)return;
    const detail=await response.json(),sessionId=detail.session?.sessionId;
    if(!sessionId||!detail.workItem?.sessionIds?.includes(sessionId))return;
    const binding={workItemId,sessionId,bindingId:query.get('mythosCodingBinding')};
    const post=(type,payload={})=>{if(parent!==window)parent.postMessage({protocol:1,...binding,type,requestId:crypto.randomUUID(),...payload},location.origin);};
    const seen=new Set();
    function ContextPort(props){
      React.useEffect(()=>{
        if(props.sessionId!==sessionId)return;
        const receive=event=>{
          if(!acceptMessage(event.data,{origin:event.origin,source:event.source,expectedOrigin:location.origin,expectedSource:parent,binding})||event.data.type!=='context.insert'||seen.has(event.data.requestId))return;
          seen.add(event.data.requestId);
          const inserted=props.inputActions.insertText('\n'+event.data.text+'\n',props.inputActions.captureInsertion());
          post('context.ack',{replyTo:event.data.requestId,inserted});
        };
        window.addEventListener('message',receive);if(ctx.sidebarRight.isExpanded())ctx.sidebarRight.toggleExpanded();post('native.ready');
        return()=>window.removeEventListener('message',receive);
      },[props.sessionId,props.inputActions]);
      return null;
    }
    function FileRoute(props){
      const {tab}=props.useTabInfo();
      React.useEffect(()=>{
        if(!tab.visible)return;
        const target=fileNavigation(tab.navigation.address,sessionId,tab.navigation.params?.file||tab.navigation.params||{});
        if(target)post('file.open',target);else post('native.error',{error:tab.kind==='files'?'请使用左侧任务文件树':'该文件不属于当前任务工作区'});
        tab.actions.close();if(ctx.sidebarRight.isExpanded())ctx.sidebarRight.toggleExpanded();
      },[tab.id,tab.visible,tab.navigation.revision]);
      return null;
    }
    if(parent!==window&&binding.bindingId){
      ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'mythos-coding-context',order:0},ContextPort));
      const type={id:'@local/mythos-coding/file',kind:'mythos-coding-file',patterns:['dsh-resource://file/**'],priority:'extension',canOpen:address=>typeof address==='string'&&address.startsWith('dsh-resource://file/'),title:()=> '任务代码区'};
      ctx.effect(()=>ctx.sidebarRightTabs.register(type));
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:type.id},FileRoute));
      const tree={id:'@local/mythos-coding/tree',kind:'files',priority:'extension',title:()=> '任务文件'};
      ctx.effect(()=>ctx.sidebarRightTabs.register(tree));
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:tree.id},FileRoute));
    }
    ctx.effect(()=>{let current=true;void openKnownSession(ctx.sessions,sessionId,id=>ctx.uiWorkspace.openSession(id),()=>current).catch(error=>{if(current)post('native.error',{error:error.message});});return()=>{current=false;};});
  }};
}});
