const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('last TCP host and port are restored on load from local storage',()=>{
 const js=read('renderer.js');
 assert.match(js,/localStorage\.getItem\('meshMarauder\.tcpHost'\)/);
 assert.match(js,/localStorage\.getItem\('meshMarauder\.tcpPort'\)/);
 assert.match(js,/restoreTcpPrefs\(\);/); // invoked at startup
});
test('TCP host and port are saved after a successful connect',()=>{
 const js=read('renderer.js');
 assert.match(js,/localStorage\.setItem\('meshMarauder\.tcpHost'/);
 assert.match(js,/localStorage\.setItem\('meshMarauder\.tcpPort'/);
 // saved only after connectTcp resolves, keeping connection manual
 assert.match(js,/await window\.marauder\.connectTcp\(\{host,port\}\);saveTcpPrefs\(host,port\);/);
});
test('preference storage access is guarded against unavailable storage',()=>{
 const js=read('renderer.js');
 assert.match(js,/function restoreTcpPrefs\(\)\{[\s\S]*?try\{[\s\S]*?\}catch\{/);
 assert.match(js,/function saveTcpPrefs\([\s\S]*?try\{[\s\S]*?\}catch\{/);
});
