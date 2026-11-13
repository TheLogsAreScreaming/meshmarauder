const {app,BrowserWindow,ipcMain,Menu,shell}=require('electron');
const path=require('node:path');
const {TcpTransport}=require('./tcp-transport.cjs');
const {UsbTransport}=require('./usb-transport.cjs');
const {BleTransport}=require('./ble-transport.cjs');
const {createBleAdapter}=require('./ble-adapter.cjs');
const {capabilities}=require('./transport-capabilities.cjs');
const {validateTcpOptions,validateUsbOptions,validateBleOptions}=require('./radio-input.cjs');
const {MeshtasticSession}=require('./meshtastic-session.cjs');
const {createMeshtasticCodec}=require('./meshtastic-codec.cjs');
const {connectWithRetry}=require('./connection-retry.cjs');
const {IntegrationHub,loadSettings,ensureSettingsFile}=require('./integrations.cjs');
const {integrationsDir}=require('./integrations-paths.cjs');
// Optional webhooks / assistant link / metrics (all off until integrations.json enables them).
const integrationsFolder=integrationsDir();
const integrations=new IntegrationHub({settings:loadSettings(integrationsFolder),dataDir:integrationsFolder});
function watchSession(s){s.on('message',message=>integrations.observe(message));s.on('status',state=>integrations.setRadio({connected:state==='session-ready'}));}
async function startIntegrations(){try{await integrations.start();}catch(error){console.error('Integrations: local API could not start:',String(error.message).slice(0,200));}}
async function reloadIntegrations(){try{await integrations.reload(loadSettings(integrationsFolder));}catch(error){console.error('Integrations: reload failed:',String(error.message).slice(0,200));}}
let transport=null;
let session=null;
function teardown(){if(session){session.close();session=null;}if(transport){transport.disconnect();transport=null;}}
function createWindow(){
 const window=new BrowserWindow({width:1180,height:760,minWidth:780,minHeight:560,backgroundColor:'#10151e',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.loadFile(path.join(__dirname,'index.html'));
 window.on('closed',()=>{teardown();});
}
ipcMain.handle('radio:tcp-connect',async(event,options)=>{
 const win=BrowserWindow.fromWebContents(event.sender);
 if(!win||!win.webContents.getURL().startsWith('file://'))throw new Error('Unauthorized renderer');
 if(transport)throw new Error('Disconnect the existing radio transport first');
 const safe=validateTcpOptions(options);
 const next=new TcpTransport({timeoutMs:10000});
 transport=next;
 if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'tcp',state:'connecting'});
 // Retry only this user-initiated connect on transient failures (radio still
 // booting, a momentary network blip) before giving up. Listeners are attached
 // after the socket opens so intermediate retry drops don't clear state.
 try{await connectWithRetry(()=>next.connect(safe),{attempts:3});}
 catch(error){next.disconnect();if(transport===next)transport=null;throw new Error(String(error.message).slice(0,300));}
 next.on('status',state=>{if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'tcp',state});if(state==='disconnected'&&transport===next){if(session){session.close();session=null;}transport=null;}});
 next.on('error',error=>{if(!win.isDestroyed())win.webContents.send('radio:error',String(error.message).slice(0,300));});
 next.on('data',bytes=>{if(!win.isDestroyed())win.webContents.send('radio:bytes',{count:bytes.length});});
 if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'tcp',state:'transport-open'});
 // Socket is open; run the real Meshtastic configuration handshake before
 // claiming a session, and stream decoded FromRadio packets to the renderer.
 try{
  const codec=await createMeshtasticCodec();
  const next_session=new MeshtasticSession(next,{codec,timeoutMs:20000});
  session=next_session;
  next_session.on('status',state=>{if(!win.isDestroyed())win.webContents.send('radio:session',{state});});
  watchSession(next_session);
  next_session.on('message',message=>{if(!win.isDestroyed())win.webContents.send('radio:packet',{variant:message.variant,summary:message.summary,meta:message.meta||null});});
  next_session.on('decode-error',error=>{if(!win.isDestroyed())win.webContents.send('radio:error','Decode error: '+String(error.message).slice(0,200));});
  await next_session.start();
  return {state:'session-ready',note:'Meshtastic configuration handshake complete; decoded packets are now live.'};
 }catch(error){teardown();throw new Error(String(error.message).slice(0,300));}
});
ipcMain.handle('radio:usb-list',async(event)=>{
 const win=BrowserWindow.fromWebContents(event.sender);
 if(!win||!win.webContents.getURL().startsWith('file://'))throw new Error('Unauthorized renderer');
 const ports=await new UsbTransport().list();
 return ports.filter(port=>typeof port.path==='string'&&port.path.startsWith('/dev/')).map(port=>({path:port.path,manufacturer:String(port.manufacturer||'').slice(0,100)}));
});
ipcMain.handle('radio:usb-connect',async(event,options)=>{
 const win=BrowserWindow.fromWebContents(event.sender);
 if(!win||!win.webContents.getURL().startsWith('file://'))throw new Error('Unauthorized renderer');
 if(transport)throw new Error('Disconnect the existing radio transport first');
 const safe=validateUsbOptions(options);
 const next=new UsbTransport({timeoutMs:10000});
 transport=next;
 if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'usb',state:'connecting'});
 // Retry only this user-initiated connect on transient failures (port briefly
 // busy right after plug-in) before giving up. Listeners are attached after the
 // port opens so intermediate retry drops don't clear state.
 try{await connectWithRetry(()=>next.connect(safe),{attempts:3});}
 catch(error){next.disconnect();if(transport===next)transport=null;throw new Error(String(error.message).slice(0,300));}
 next.on('status',state=>{if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'usb',state});if(state==='disconnected'&&transport===next){if(session){session.close();session=null;}transport=null;}});
 next.on('error',error=>{if(!win.isDestroyed())win.webContents.send('radio:error',String(error.message).slice(0,300));});
 next.on('data',bytes=>{if(!win.isDestroyed())win.webContents.send('radio:bytes',{count:bytes.length});});
 if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'usb',state:'transport-open'});
 // Serial port is open; run the same Meshtastic configuration handshake used
 // for TCP before claiming a session, and stream decoded packets.
 try{
  const codec=await createMeshtasticCodec();
  const next_session=new MeshtasticSession(next,{codec,timeoutMs:20000});
  session=next_session;
  next_session.on('status',state=>{if(!win.isDestroyed())win.webContents.send('radio:session',{state});});
  watchSession(next_session);
  next_session.on('message',message=>{if(!win.isDestroyed())win.webContents.send('radio:packet',{variant:message.variant,summary:message.summary,meta:message.meta||null});});
  next_session.on('decode-error',error=>{if(!win.isDestroyed())win.webContents.send('radio:error','Decode error: '+String(error.message).slice(0,200));});
  await next_session.start();
  return {state:'session-ready',note:'Meshtastic configuration handshake complete over USB; decoded packets are now live.'};
 }catch(error){teardown();throw new Error(String(error.message).slice(0,300));}
});
ipcMain.handle('radio:capabilities',async(event)=>{
 const win=BrowserWindow.fromWebContents(event.sender);
 if(!win||!win.webContents.getURL().startsWith('file://'))throw new Error('Unauthorized renderer');
 // USB serial ships with the app; BLE depends on a native adapter that is not
 // bundled, so createBleAdapter() returns null and bluetooth stays unavailable.
 return capabilities({bleAdapter:createBleAdapter(),serialAdapter:UsbTransport});
});
ipcMain.handle('radio:ble-list',async(event)=>{
 const win=BrowserWindow.fromWebContents(event.sender);
 if(!win||!win.webContents.getURL().startsWith('file://'))throw new Error('Unauthorized renderer');
 // Rejects with an explicit "not installed" error until a validated native BLE
 // adapter is present; no scanning is attempted without one.
 const devices=await new BleTransport({adapter:createBleAdapter()}).list();
 return devices.filter(device=>device&&typeof device.id==='string').map(device=>({id:String(device.id).slice(0,200),name:String(device.name||'').slice(0,100)}));
});
ipcMain.handle('radio:ble-connect',async(event,options)=>{
 const win=BrowserWindow.fromWebContents(event.sender);
 if(!win||!win.webContents.getURL().startsWith('file://'))throw new Error('Unauthorized renderer');
 if(transport)throw new Error('Disconnect the existing radio transport first');
 const safe=validateBleOptions(options);
 const next=new BleTransport({adapter:createBleAdapter()});
 transport=next;
 if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'ble',state:'connecting'});
 // Same bounded retry and post-open listener attachment as TCP/USB. Without a
 // native adapter this rejects immediately with a clear message; with a
 // validated adapter it runs the identical Meshtastic handshake pipeline.
 try{await connectWithRetry(()=>next.connect(safe),{attempts:3});}
 catch(error){next.disconnect();if(transport===next)transport=null;throw new Error(String(error.message).slice(0,300));}
 next.on('status',state=>{if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'ble',state});if(state==='disconnected'&&transport===next){if(session){session.close();session=null;}transport=null;}});
 next.on('error',error=>{if(!win.isDestroyed())win.webContents.send('radio:error',String(error.message).slice(0,300));});
 next.on('data',bytes=>{if(!win.isDestroyed())win.webContents.send('radio:bytes',{count:bytes.length});});
 if(!win.isDestroyed())win.webContents.send('radio:status',{transport:'ble',state:'transport-open'});
 try{
  const codec=await createMeshtasticCodec();
  const next_session=new MeshtasticSession(next,{codec,timeoutMs:20000});
  session=next_session;
  next_session.on('status',state=>{if(!win.isDestroyed())win.webContents.send('radio:session',{state});});
  watchSession(next_session);
  next_session.on('message',message=>{if(!win.isDestroyed())win.webContents.send('radio:packet',{variant:message.variant,summary:message.summary,meta:message.meta||null});});
  next_session.on('decode-error',error=>{if(!win.isDestroyed())win.webContents.send('radio:error','Decode error: '+String(error.message).slice(0,200));});
  await next_session.start();
  return {state:'session-ready',note:'Meshtastic configuration handshake complete over Bluetooth; decoded packets are now live.'};
 }catch(error){teardown();throw new Error(String(error.message).slice(0,300));}
});
ipcMain.handle('radio:disconnect',()=>{teardown();return {state:'disconnected'};});
app.whenReady().then(()=>{Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Mesh Marauder',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{label:'Quit Mesh Marauder',accelerator:'CommandOrControl+Q',click:()=>app.quit()}]},{role:'editMenu'},{role:'viewMenu'},{label:'Integrations',submenu:[{label:'Open Integrations Settings…',click:()=>{shell.openPath(ensureSettingsFile(integrationsFolder));}},{label:'Reload Integrations Settings',click:()=>{reloadIntegrations();}},{label:'Show Integrations Folder',click:()=>{shell.showItemInFolder(ensureSettingsFile(integrationsFolder));}}]},{role:'windowMenu'}]));startIntegrations();createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{teardown();});
app.on('will-quit',()=>{integrations.stop();});
