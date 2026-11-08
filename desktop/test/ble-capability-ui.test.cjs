const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {capabilities}=require('../transport-capabilities.cjs');

test('bluetooth stays unavailable until a native adapter is provided',()=>{
 assert.equal(capabilities().bluetooth.available,false);
 assert.equal(capabilities({bleAdapter:{}}).bluetooth.available,true);
});

test('main exposes a capabilities probe and the UI gates BLE on it',()=>{
 assert.match(read('main.cjs'),/ipcMain\.handle\('radio:capabilities'/);
 assert.match(read('preload.cjs'),/getCapabilities:\(\)=>ipcRenderer\.invoke\('radio:capabilities'\)/);
 assert.match(read('renderer.js'),/getCapabilities\(\)\.then/);
 assert.match(read('renderer.js'),/ble\.available/);
});

test('BLE controls ship disabled and clearly experimental',()=>{
 const html=read('index.html');
 assert.match(html,/id="connectBle"[^>]*disabled/);
 assert.match(html,/id="refreshBle"[^>]*disabled/);
 assert.match(html,/Experimental/);
});
