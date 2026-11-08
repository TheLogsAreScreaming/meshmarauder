const test=require('node:test');const assert=require('node:assert/strict');
const {createBleAdapter,tryLoadNativeAdapter}=require('../ble-adapter.cjs');
const {BleTransport}=require('../ble-transport.cjs');

test('no native BLE backend is bundled by default',()=>{
 assert.equal(tryLoadNativeAdapter(),null);
 assert.equal(createBleAdapter(),null);
});

test('createBleAdapter honors an injected backend loader',()=>{
 const backend={list:async()=>[],connect:async()=>{},send:async()=>{},disconnect:async()=>{}};
 assert.equal(createBleAdapter({load:()=>backend}),backend);
});

test('a transport built with the default (null) adapter refuses discovery',async()=>{
 const ble=new BleTransport({adapter:createBleAdapter()});
 await assert.rejects(ble.list(),/not installed/);
});
