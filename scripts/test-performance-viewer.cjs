// Run the actual built renderer in a separate display and synthetic Electron
// data directory. This harness never launches electron/main.cjs or opens archives.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function runRenderer() {
  const { app, BrowserWindow } = require('electron');
  const root = process.env.AIBACKMAN_VIEWER_TEST_ROOT;
  app.setPath('userData', path.join(root, 'electron-user-data'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({ width: 1400, height: 900, show: true,
    webPreferences: { preload: path.join(root, 'preload.cjs'), sandbox: false, contextIsolation: true } });
  const errors = [];
  const resources = [];
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    resources.push(details.url);
    callback({ cancel: /^https?:/.test(details.url) });
  });
  const evaluate = (script) => window.webContents.executeJavaScript(script);
  const until = async (script, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Renderer condition not met: ${label}`);
  };
  try {
    await window.loadFile(path.resolve(__dirname, '../dist/index.html'));
    await until("document.querySelector('.account-card-main')", 'synthetic home card');
    assert.equal(resources.some((url) => url.includes('ChatWorkspace-') && url.endsWith('.js')), false, 'Home must not load the Markdown/workspace bundle.');
    await evaluate("document.querySelector('.account-card-main').click()");
    await until("document.querySelector('.conversation-item')", 'conversation list');
    await evaluate("document.querySelector('.conversation-item').click()");
    await until("document.querySelectorAll('.content-nav-item').length > 0", 'message map rows');
    const initial = await evaluate(`({ mapRows: document.querySelectorAll('.content-nav-item').length,
      chatRows: document.querySelectorAll('.message-row').length })`);
    assert.ok(initial.mapRows < 100, `Message Map mounted ${initial.mapRows} of 10,000 rows.`);
    assert.ok(initial.chatRows < 100);
    assert.equal(resources.some((url) => url.includes('ChatWorkspace-') && url.endsWith('.js')), true);
    await evaluate(`document.querySelector('.content-nav-list [data-virtuoso-scroller]').scrollTop = 0;
      document.querySelector('.content-nav-list').dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:1, clientX:100, clientY:100}));`);
    await until("document.querySelector('.pan-overlay')", 'middle-button panning begins');
    await evaluate("window.dispatchEvent(new MouseEvent('mousemove', {clientX:100, clientY:200}))");
    await until("document.querySelector('.content-nav-list [data-virtuoso-scroller]').scrollTop > 0", 'middle-button map panning scrolls');
    await evaluate("window.dispatchEvent(new MouseEvent('mouseup', {button:1}))");
    await until("!document.querySelector('.pan-overlay')", 'panning stops');
    await evaluate(`document.querySelector('.content-nav-list [data-virtuoso-scroller]').scrollTop = 10000000`);
    await until("[...document.querySelectorAll('.content-nav-item')].some(row=>row.dataset.messageId==='message-9999')", 'last map message reachable');
    await evaluate("document.querySelector('.content-nav-item[data-message-id=\"message-9999\"]').click()");
    await until("document.querySelector('.message-row[data-message-id=\"message-9999\"]')", 'jump to last chat message');
    assert.equal(await evaluate("document.querySelectorAll('.content-nav-item').length < 100"), true);
    await evaluate(`document.querySelector('.content-nav-list [data-virtuoso-scroller]').scrollTop = 0`);
    await until("document.querySelector('.content-nav-item[data-message-id=\"message-0\"]')", 'first message reachable again');
    await evaluate("document.querySelector('.content-nav-item[data-message-id=\"message-0\"]').click()");
    await until("document.querySelector('.message-row[data-message-id=\"message-0\"] table')", 'Markdown table preserved');
    const table = await evaluate("[...document.querySelector('.message-row[data-message-id=\"message-0\"] table').querySelectorAll('th')].map(cell=>cell.textContent)");
    assert.deepEqual(table, ['Type', 'Meaning']);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ contract: 'PERF-RENDER', profile: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../dist/build-info.json'), 'utf8')).build_mode,
      artifact: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../dist/build-info.json'), 'utf8')).build_id, messages: 10000, initial, outcome: 'passed', environment: 'isolated Electron/Xvfb' }));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    throw error;
  } finally { window.destroy(); app.quit(); }
}

async function launchHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibackman-viewer-test-'));
  const preload = `const {contextBridge}=require('electron');
    const messages=Array.from({length:10000},(_,index)=>({id:'message-'+index,conversation_id:'fixture',role:index%2?'assistant':'user',content:index===0?'| Type | Meaning |\\n| --- | --- |\\n| Fixture | Preserved |':'Synthetic message '+index,created_at:index+1,parent_id:index?'message-'+(index-1):null,metadata_json:'{}'}));
    const conversation={id:'fixture',title:'Synthetic long chat',created_at:1,updated_at:10000,current_node_id:'message-9999',message_count:10000};
    const account={id:'synthetic',agentId:'codex',agentName:'Codex CLI',agentAccent:'#ffffff',label:'Synthetic account',sourceKind:'local',capabilities:{localBackup:true},stats:{conversationCount:1,messageCount:10000,cachedCount:1}};
    contextBridge.exposeInMainWorld('electronAPI',{onArchiveChanged:()=>()=>{},onCacheProgress:()=>()=>{},onSendProgress:()=>()=>{},invoke:async(channel)=>{
      if(channel==='archive:getOverview')return {agents:[{id:'codex',name:'Codex CLI',accent:'#ffffff',capabilities:{localBackup:true},accounts:[account]}],totals:{accounts:1,conversations:1,messages:10000}};
      if(channel==='db:getConversations')return [conversation];
      if(channel==='api:syncConversations')return {conversations:[conversation],hasMore:false};
      if(channel==='db:getConversationState')return {conversation,currentNodeId:'message-9999',allMessages:messages,currentMessageIds:messages.map(message=>message.id)};
      if(channel==='db:getStats')return {localCount:1,cachedCount:1};
      if(channel==='db:getCacheDiagnostics')return {uncachedRows:[],newMessageRows:[],resyncRows:[]};
      return {};
    }});`;
  fs.writeFileSync(path.join(root, 'preload.cjs'), preload);
  const env = { ...process.env, AIBACKMAN_VIEWER_TEST_ROOT: root, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
  delete env.ELECTRON_RUN_AS_NODE;
  let passed = false;
  try {
    const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', require('electron'), '--ozone-platform=x11', '--disable-gpu', __filename, '--renderer'], { env, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timeout);
    assert.equal(status, 0, `Viewer regression failed; synthetic failure evidence retained at ${root}`);
    passed = true;
  } finally { if (passed) fs.rmSync(root, { recursive: true, force: true }); }
}

(process.argv.includes('--renderer') ? runRenderer() : launchHarness()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  if (process.argv.includes('--renderer')) require('electron').app.exit(1);
});
