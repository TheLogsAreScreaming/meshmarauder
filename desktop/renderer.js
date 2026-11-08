const theme=document.querySelector('#theme');
const savedTheme=localStorage.getItem('meshMarauder.theme');
const options=['neon','mocha','vibrant','dusk'];
function setTheme(value){const safe=options.includes(value)?value:'neon';document.body.dataset.theme=safe;theme.value=safe;localStorage.setItem('meshMarauder.theme',safe);}
setTheme(savedTheme);
theme.addEventListener('change',()=>setTheme(theme.value));
// Remember the last TCP host/port locally so a reconnect doesn't require
// retyping them. These only pre-fill the inputs; connecting stays a manual,
// explicit action and the main process still validates the values.
function restoreTcpPrefs(){
 try{
  const host=localStorage.getItem('meshMarauder.tcpHost');if(host)document.querySelector('#tcpHost').value=host;
  const port=localStorage.getItem('meshMarauder.tcpPort');if(port)document.querySelector('#tcpPort').value=port;
 }catch{/* storage unavailable (private mode / blocked) — inputs keep defaults */}
}
function saveTcpPrefs(host,port){
 try{localStorage.setItem('meshMarauder.tcpHost',String(host));localStorage.setItem('meshMarauder.tcpPort',String(port));}catch{/* ignore storage failures */}
}
restoreTcpPrefs();
let livePackets=0,demoPackets=0;
function refreshPacketStats(){document.querySelector('#livePacketCount').textContent=String(livePackets);document.querySelector('#demoPacketCount').textContent=String(demoPackets);}
document.querySelector('#toggleDemo').addEventListener('click',()=>{
 demoPackets++;refreshPacketStats();
 const monitor=document.querySelector('#packetList');const empty=monitor.querySelector('.empty');if(empty)empty.remove();
 const row=document.createElement('div');row.className='packet';row.dataset.source='demo';const label=document.createElement('strong');label.textContent='DEMO / SIMULATED';row.append(label,document.createTextNode('  '+new Date().toLocaleTimeString()+' · sample mesh packet · No radio traffic'));monitor.prepend(row);applyFilter();while(monitor.children.length>200)monitor.lastChild.remove();
});

document.querySelector('#exportPackets').addEventListener('click',()=>{
 const rows=[...document.querySelectorAll('#packetList .packet')].filter(row=>!row.hidden).map(row=>({source:row.dataset.source||'unknown',summary:row.textContent}));
 if(!rows.length)return;
 const csv=['source,summary',...rows.map(row=>[row.source,row.summary].map(value=>'"'+String(value).replace(/^[\s\u0000-\u001f]*[=+@-]/,match=>"'"+match).replace(/"/g,'""')+'"').join(','))].join('\r\n');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
 const anchor=document.createElement('a');anchor.href=url;anchor.download='meshmarauder-visible-packets.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
const sourceFilter=document.querySelector('#packetSourceFilter');
const filter=document.querySelector('#packetFilter');const clearPackets=document.querySelector('#clearPackets');const packetList=document.querySelector('#packetList');
function applyFilter(){const term=filter.value.trim().toLowerCase();for(const item of packetList.querySelectorAll('.packet'))item.hidden=!item.textContent.toLowerCase().includes(term)||(sourceFilter.value!=='all'&&item.dataset.source!==sourceFilter.value);}
filter.addEventListener('input',applyFilter);sourceFilter.addEventListener('change',applyFilter);clearPackets.addEventListener('click',()=>{if(packetList.querySelector('.packet')&&!confirm('Clear all packets from the monitor view? This cannot be undone.'))return;packetList.replaceChildren();livePackets=0;demoPackets=0;document.querySelector('#lastLivePacket').textContent='None';refreshPacketStats();});
const connectionBanner=document.querySelector('#connectionBanner');
const diagnosticTransport=document.querySelector('#diagnosticTransport');
const diagnosticState=document.querySelector('#diagnosticState');
const diagnosticTip=document.querySelector('#diagnosticTip');
const diagnosticError=document.querySelector('#diagnosticError');
const diagnosticTips={'disconnected':'Choose a radio and connect over TCP or USB.','connecting':'Opening transport. Check the radio address, port or USB cable if this stalls.','transport-open':'Transport opened; waiting for the Meshtastic configuration handshake.','initializing':'Meshtastic handshake in progress. If it times out, check for another connected client.','session-ready':'Meshtastic configuration completed. Live packets can now be monitored.','needs-attention':'Check the error below, radio power, permissions and connection settings.'};
function updateDiagnostics(state){diagnosticTransport.textContent=activeTransport.toUpperCase();diagnosticState.textContent=state.replace(/-/g,' ');diagnosticTip.textContent=diagnosticTips[state]||diagnosticTips['needs-attention'];if(state==='session-ready'||state==='connecting')diagnosticError.textContent='';}

function updateBanner(state){
 const labels={'disconnected':'NO RADIO CONNECTED · DEMO AVAILABLE','connecting':'CONNECTING TO RADIO','transport-open':'TCP OPEN · HANDSHAKE PENDING','initializing':'TCP OPEN · HANDSHAKE PENDING','session-ready':'LIVE RADIO · SESSION READY'};
 const transportName=activeTransport==='ble'?'BLE':activeTransport==='usb'?'USB':'TCP';
 connectionBanner.textContent=(state==='transport-open'||state==='initializing')?transportName+' OPEN · HANDSHAKE PENDING':labels[state]||'RADIO NEEDS ATTENTION';
 connectionBanner.dataset.connectionState=state;
 updateDiagnostics(state);
}
const tcpStatus=document.querySelector('#tcpStatus');
const tcpMessage=document.querySelector('#tcpMessage');
const tcpConnect=document.querySelector('#connectTcp');
const tcpDisconnect=document.querySelector('#disconnectTcp');
const usbRefresh=document.querySelector('#refreshUsb');
const usbPorts=document.querySelector('#usbPorts');
const usbStatus=document.querySelector('#usbStatus');
const usbMessage=document.querySelector('#usbMessage');
const usbConnect=document.querySelector('#connectUsb');
const usbDisconnect=document.querySelector('#disconnectUsb');
const bleRefresh=document.querySelector('#refreshBle');
const blePorts=document.querySelector('#blePorts');
const bleStatus=document.querySelector('#bleStatus');
const bleMessage=document.querySelector('#bleMessage');
const bleConnect=document.querySelector('#connectBle');
const bleDisconnect=document.querySelector('#disconnectBle');
// One transport is active at a time; remember which so the shared session,
// error and byte events update the right card.
let activeTransport='tcp';
if(window.marauder?.connectTcp){
 window.marauder.onStatus(({transport,state})=>{
  if(transport&&state!=='disconnected')activeTransport=transport;
  updateBanner(state);
  if(transport==='usb'){usbStatus.textContent=state==='transport-open'?'Serial port open — handshake pending':state.replace(/-/g,' ');usbConnect.disabled=state==='connecting'||state==='transport-open';if(state==='disconnected'){usbConnect.disabled=false;usbMessage.textContent='Radio disconnected. Reconnect when ready.';}}
  else if(transport==='ble'){bleStatus.textContent=state==='transport-open'?'Bluetooth link open — handshake pending':state.replace(/-/g,' ');bleConnect.disabled=state==='connecting'||state==='transport-open';if(state==='disconnected'){bleConnect.disabled=false;bleMessage.textContent='Bluetooth radio disconnected. Reconnect when ready.';}}
  else{tcpStatus.textContent=state==='transport-open'?'TCP socket open — handshake pending':state.replace(/-/g,' ');tcpConnect.disabled=state==='connecting'||state==='transport-open';if(state==='disconnected'){tcpConnect.disabled=false;tcpMessage.textContent='Radio disconnected. Reconnect when ready.';}}
 });
 const activeMessageEl=()=>activeTransport==='ble'?bleMessage:activeTransport==='usb'?usbMessage:tcpMessage;
 window.marauder.onError(message=>{activeMessageEl().textContent='Radio error: '+message;diagnosticError.textContent=String(message).slice(0,300);updateBanner('needs-attention');});
 window.marauder.onBytes(({count})=>{activeMessageEl().textContent='Received '+count+' transport bytes; awaiting Meshtastic configuration handshake.';});
 window.marauder.onSession?.(({state})=>{updateBanner(state);
  const statusEl=activeTransport==='ble'?bleStatus:activeTransport==='usb'?usbStatus:tcpStatus;
  if(state==='initializing')statusEl.textContent='Transport open — Meshtastic handshake in progress';
  else if(state==='session-ready')statusEl.textContent='Session ready — decoding live packets';
  else if(state==='disconnected'){statusEl.textContent='Not connected';tcpConnect.disabled=false;usbConnect.disabled=false;bleConnect.disabled=false;}
  else statusEl.textContent=state.replace(/-/g,' ');
 });
 window.marauder.onPacket?.(packet=>{
  if(!packet||packet.variant!=='packet')return;
  observeNode(packet);
  const monitor=document.querySelector('#packetList');const empty=monitor.querySelector('.empty');if(empty)empty.remove();
  livePackets++;document.querySelector('#lastLivePacket').textContent=new Date().toLocaleTimeString();refreshPacketStats();
  const row=document.createElement('div');row.className='packet';row.dataset.source='live';
  const label=document.createElement('strong');label.textContent='LIVE';
  const summary=packet.summary||packet.variant||'packet';
  row.append(label,document.createTextNode('  '+new Date().toLocaleTimeString()+' · '+String(summary).slice(0,200)));
  if(packet.meta&&typeof packet.meta==='object'){
   const details=document.createElement('details');const heading=document.createElement('summary');heading.textContent='Packet metadata';details.append(heading);
   const fields=['from','to','channel','id','rxTime','rxSnr','rxRssi','hopLimit','portnum','encrypted'];
   for(const field of fields){const value=packet.meta[field];if(value===undefined||value===null)continue;const line=document.createElement('div');line.textContent=field+': '+String(value).slice(0,100);details.append(line);}
   row.append(details);
  }
  monitor.prepend(row);applyFilter();
  while(monitor.children.length>200)monitor.lastChild.remove();
 });
 tcpConnect.addEventListener('click',async()=>{
  tcpConnect.disabled=true;tcpMessage.textContent='Opening TCP socket…';
  const host=document.querySelector('#tcpHost').value;const port=Number(document.querySelector('#tcpPort').value);
  try{const result=await window.marauder.connectTcp({host,port});saveTcpPrefs(host,port);tcpMessage.textContent=result.note;}
  catch(error){updateBanner('needs-attention');diagnosticError.textContent=String(error.message).slice(0,300);tcpMessage.textContent='Connection failed: '+String(error.message).slice(0,300);tcpConnect.disabled=false;}
 });
 tcpDisconnect.addEventListener('click',async()=>{try{await window.marauder.disconnect();tcpStatus.textContent='Not connected';updateBanner('disconnected');tcpMessage.textContent='Disconnected';tcpConnect.disabled=false;}catch(error){tcpMessage.textContent='Disconnect error: '+String(error.message).slice(0,300);}});
 usbRefresh.addEventListener('click',async()=>{
  usbRefresh.disabled=true;usbStatus.textContent='Searching for serial devices…';usbPorts.replaceChildren();
  try{
   const ports=await window.marauder.listUsbPorts();
   const empty=document.createElement('option');empty.value='';empty.textContent='Select a device';usbPorts.append(empty);
   for(const port of ports){const option=document.createElement('option');option.value=port.path;option.textContent=port.path+(port.manufacturer?' · '+port.manufacturer:'');usbPorts.append(option);}
   usbStatus.textContent=ports.length+' serial device(s) found · Not connected';
  }catch(error){usbStatus.textContent='Discovery failed: '+String(error.message).slice(0,160);}
  finally{usbRefresh.disabled=false;}
 });
 usbConnect.addEventListener('click',async()=>{
  const path=usbPorts.value;
  if(!path){usbMessage.textContent='Find and select a serial device first.';return;}
  usbConnect.disabled=true;usbMessage.textContent='Opening serial port…';
  try{const result=await window.marauder.connectUsb({path});usbMessage.textContent=result.note;}
  catch(error){updateBanner('needs-attention');diagnosticError.textContent=String(error.message).slice(0,300);usbMessage.textContent='Connection failed: '+String(error.message).slice(0,300);usbConnect.disabled=false;}
 });
 usbDisconnect.addEventListener('click',async()=>{try{await window.marauder.disconnect();usbStatus.textContent='Not connected';updateBanner('disconnected');usbMessage.textContent='Disconnected';usbConnect.disabled=false;}catch(error){usbMessage.textContent='Disconnect error: '+String(error.message).slice(0,300);}});
 // Bluetooth is experimental. The controls stay disabled until the main process
 // reports a validated native adapter (capabilities().bluetooth.available); none
 // is bundled, so in the shipped app this keeps the card honestly unavailable.
 if(window.marauder.getCapabilities){
  window.marauder.getCapabilities().then(caps=>{
   const ble=caps&&caps.bluetooth;
   if(ble&&ble.available){
    if(bleRefresh)bleRefresh.disabled=false;
    bleStatus.textContent='Adapter ready — not connected';
    bleMessage.textContent='Scan for a nearby Meshtastic device, then open the Bluetooth transport.';
   }else{
    bleStatus.textContent='Unavailable';
    bleMessage.textContent=(ble&&ble.reason?ble.reason:'Bluetooth adapter not installed')+'. Bluetooth stays disabled until a validated native adapter is installed and verified on hardware.';
   }
  }).catch(()=>{});
 }
 if(window.marauder.connectBle&&bleRefresh){
  bleRefresh.addEventListener('click',async()=>{
   bleRefresh.disabled=true;bleStatus.textContent='Scanning for Bluetooth devices…';blePorts.replaceChildren();
   try{
    const devices=await window.marauder.listBle();
    const empty=document.createElement('option');empty.value='';empty.textContent='Select a device';blePorts.append(empty);
    for(const device of devices){const option=document.createElement('option');option.value=device.id;option.textContent=(device.name?device.name+' · ':'')+device.id;blePorts.append(option);}
    blePorts.disabled=false;bleStatus.textContent=devices.length+' Bluetooth device(s) found · Not connected';
   }catch(error){bleStatus.textContent='Unavailable';bleMessage.textContent='Bluetooth discovery failed: '+String(error.message).slice(0,160);}
   finally{bleRefresh.disabled=false;}
  });
  blePorts.addEventListener('change',()=>{bleConnect.disabled=!blePorts.value;});
  bleConnect.addEventListener('click',async()=>{
   const id=blePorts.value;
   if(!id){bleMessage.textContent='Scan and select a Bluetooth device first.';return;}
   bleConnect.disabled=true;bleMessage.textContent='Opening Bluetooth transport…';
   try{const result=await window.marauder.connectBle({id});bleMessage.textContent=result.note;}
   catch(error){updateBanner('needs-attention');diagnosticError.textContent=String(error.message).slice(0,300);bleMessage.textContent='Connection failed: '+String(error.message).slice(0,300);bleConnect.disabled=false;}
  });
  bleDisconnect.addEventListener('click',async()=>{try{await window.marauder.disconnect();bleStatus.textContent='Not connected';updateBanner('disconnected');bleMessage.textContent='Disconnected';bleConnect.disabled=false;}catch(error){bleMessage.textContent='Disconnect error: '+String(error.message).slice(0,300);}});
 }
}

// Keep workspace navigation synchronized with the visible section.
const workspaceLinks=[...document.querySelectorAll('.sidebar nav a[href^="#"]')];
function syncWorkspaceNavigation(){
 const selected=workspaceLinks.find(link=>link.getAttribute('href')===window.location.hash)||workspaceLinks[0];
 for(const link of workspaceLinks){
  const active=link===selected;
  link.classList.toggle('selected',active);
  if(active)link.setAttribute('aria-current','location');
  else link.removeAttribute('aria-current');
 }
}
window.addEventListener('hashchange',syncWorkspaceNavigation);
syncWorkspaceNavigation();

// Live-only node observations: bounded to the latest 100 unique senders.
const observedNodes=new Map();
function observeNode(packet){
 if(packet?.variant!=='packet'||!packet.meta||!Number.isSafeInteger(packet.meta.from)||packet.meta.from<=0||packet.meta.from>0xffffffff)return;
 const meta=packet.meta, id=meta.from>>>0, now=new Date();
 if(observedNodes.has(id))observedNodes.delete(id);
 observedNodes.set(id,{id,lastSeen:now.toLocaleTimeString(),snr:typeof meta.rxSnr==='number'&&Number.isFinite(meta.rxSnr)?meta.rxSnr:null,rssi:typeof meta.rxRssi==='number'&&Number.isFinite(meta.rxRssi)?meta.rxRssi:null,channel:Number.isInteger(meta.channel)?meta.channel:null});
 while(observedNodes.size>100)observedNodes.delete(observedNodes.keys().next().value);
 const list=document.querySelector('#nodeList');list.replaceChildren();
 for(const node of [...observedNodes.values()].reverse()){
  const row=document.createElement('div');row.className='node-row';row.setAttribute('role','listitem');
  const name=document.createElement('strong');name.textContent='!'+node.id.toString(16).padStart(8,'0');
  const details=document.createElement('span');details.textContent='Last packet '+node.lastSeen+' · SNR '+(node.snr===null?'N/A':node.snr+' dB')+' · RSSI '+(node.rssi===null?'N/A':node.rssi+' dBm')+' · Channel '+(node.channel===null?'N/A':node.channel);
  row.append(name,details);list.append(row);
 }
 document.querySelector('#nodeCount').textContent=observedNodes.size+' observed node'+(observedNodes.size===1?'':'s');
}

// Export only live-observed node records; no demo packets enter this map.
document.querySelector('#exportNodes').addEventListener('click',()=>{
 if(!observedNodes.size)return;
 const csv=['node_id,last_seen,snr_db,rssi_dbm,channel',...[...observedNodes.values()].map(node=>[
  '!'+node.id.toString(16).padStart(8,'0'),node.lastSeen,node.snr??'',node.rssi??'',node.channel??''
 ].map(value=>'"'+String(value).replace(/^[\s\u0000-\u001f]*[=+@-]/,match=>"'"+match).replace(/"/g,'""')+'"').join(','))].join('\r\n');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
 const anchor=document.createElement('a');anchor.href=url;anchor.download='meshmarauder-observed-nodes.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
