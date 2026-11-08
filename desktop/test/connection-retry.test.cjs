const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {isTransient,backoffMs,connectWithRetry}=require('../connection-retry.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('isTransient recognizes retryable transport failures only',()=>{
 assert.equal(isTransient({code:'ECONNREFUSED'}),true);
 assert.equal(isTransient({code:'ETIMEDOUT'}),true);
 assert.equal(isTransient(new Error('TCP connection timed out')),true);
 assert.equal(isTransient(new Error('Resource temporarily unavailable')),true);
 assert.equal(isTransient({code:'EACCES'}),false);
 assert.equal(isTransient(new Error('Invalid macOS USB device path')),false);
 assert.equal(isTransient(null),false);
});

test('backoff grows and is capped',()=>{
 assert.equal(backoffMs(1,{baseMs:400,maxMs:3000}),400);
 assert.equal(backoffMs(2,{baseMs:400,maxMs:3000}),800);
 assert.equal(backoffMs(3,{baseMs:400,maxMs:3000}),1600);
 assert.equal(backoffMs(10,{baseMs:400,maxMs:3000}),3000);
 assert.throws(()=>backoffMs(0),/positive integer/);
});

test('connectWithRetry succeeds after transient failures',async()=>{
 let calls=0;const delays=[];
 const result=await connectWithRetry(async()=>{calls++;if(calls<3)throw Object.assign(new Error('refused'),{code:'ECONNREFUSED'});return 'open';},
  {attempts:3,delay:ms=>{delays.push(ms);return Promise.resolve();}});
 assert.equal(result,'open');
 assert.equal(calls,3);
 assert.deepEqual(delays,[400,800]); // waited before attempts 2 and 3, not after success
});

test('connectWithRetry does not retry a non-transient failure',async()=>{
 let calls=0;
 await assert.rejects(connectWithRetry(async()=>{calls++;throw Object.assign(new Error('bad port'),{code:'EACCES'});},
  {attempts:5,delay:()=>Promise.resolve()}),/bad port/);
 assert.equal(calls,1);
});

test('connectWithRetry gives up after the attempt budget and throws the last error',async()=>{
 let calls=0;
 await assert.rejects(connectWithRetry(async()=>{calls++;throw Object.assign(new Error('still refused'),{code:'ECONNREFUSED'});},
  {attempts:3,delay:()=>Promise.resolve()}),/still refused/);
 assert.equal(calls,3);
});

test('main wires the user-initiated connect through connectWithRetry for both transports',()=>{
 const main=read('main.cjs');
 assert.match(main,/connectWithRetry\(\(\)=>next\.connect\(safe\),\{attempts:3\}\)/);
 assert.equal((main.match(/connectWithRetry\(/g)||[]).length,3); // TCP, USB and BLE
 // The unexpected-drop handler (manual reconnect) is preserved for every transport.
 assert.equal((main.match(/if\(state==='disconnected'&&transport===next\)\{if\(session\)\{session\.close\(\);session=null;\}transport=null;\}/g)||[]).length,3);
});
