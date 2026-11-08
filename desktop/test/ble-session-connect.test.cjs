const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {BleTransport}=require('../ble-transport.cjs');
const {MeshtasticSession}=require('../meshtastic-session.cjs');
const {createMeshtasticCodec}=require('../meshtastic-codec.cjs');
const {frame}=require('../meshtastic-framing.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('BLE connect is wired through to the Meshtastic session',()=>{
 assert.match(read('main.cjs'),/radio:ble-connect/);
 assert.match(read('main.cjs'),/radio:ble-list/);
 // Unexpected Bluetooth drop must close the session and release the transport, same as TCP/USB.
 assert.match(read('main.cjs'),/if\(state==='disconnected'&&transport===next\)\{if\(session\)\{session\.close\(\);session=null;\}transport=null;\}/);
 assert.match(read('preload.cjs'),/connectBle:options=>ipcRenderer\.invoke\('radio:ble-connect',options\)/);
 assert.match(read('index.html'),/id="connectBle"/);
 assert.match(read('renderer.js'),/window\.marauder\.connectBle\(\{id\}\)/);
});

// A fake BLE adapter that behaves like a Meshtastic radio over GATT: when the
// transport writes a framed ToRadio want_config, it answers with a decoded
// packet and the matching config-complete, exercising the full BLE -> handshake
// path exactly as a validated native adapter eventually would.
function fakeBleAdapter(libs){
 const {create,toBinary,fromBinary,protobufs}=libs;
 const FR=protobufs.Mesh.FromRadioSchema,TR=protobufs.Mesh.ToRadioSchema,MP=protobufs.Mesh.MeshPacketSchema;
 let onData=null,buf=Buffer.alloc(0);
 return {
  async list(){return [{id:'ble-radio',name:'Meshtastic_BLE'}];},
  async connect(id,opts){onData=opts.onData;},
  async send(data){
   buf=Buffer.concat([buf,Buffer.from(data)]);
   while(buf.length>=4){const size=buf.readUInt16BE(2);if(buf.length<size+4)break;const payload=Buffer.from(buf.subarray(4,size+4));buf=buf.subarray(size+4);
    const tr=fromBinary(TR,Uint8Array.from(payload));const nonce=tr.payloadVariant.value;
    const pkt=create(MP,{from:0xbee,to:0xffffffff,channel:2,id:11,payloadVariant:{case:'decoded',value:{portnum:protobufs.Portnums.PortNum.TEXT_MESSAGE_APP}}});
    onData(frame(Buffer.from(toBinary(FR,create(FR,{payloadVariant:{case:'packet',value:pkt}})))));
    onData(frame(Buffer.from(toBinary(FR,create(FR,{payloadVariant:{case:'configCompleteId',value:nonce}})))));
   }
  },
  async disconnect(){}
 };
}

test('BLE transport completes the real handshake and decodes a packet with a validated adapter',async()=>{
 const [buf,protobufs]=await Promise.all([import('@bufbuild/protobuf'),import('@meshtastic/protobufs')]);
 const libs={create:buf.create,toBinary:buf.toBinary,fromBinary:buf.fromBinary,protobufs};
 const codec=await createMeshtasticCodec();
 const ble=new BleTransport({adapter:fakeBleAdapter(libs)});
 const session=new MeshtasticSession(ble,{codec,timeoutMs:1000});
 const seen=[];session.on('message',m=>seen.push(m));
 await ble.connect('ble-radio');
 await session.start();
 assert.equal(session.state,'session-ready');
 assert.ok(seen.some(m=>m.variant==='packet'&&/TEXT_MESSAGE_APP/.test(m.summary)));
 assert.ok(seen.some(m=>m.variant==='configCompleteId'));
 session.close();await ble.disconnect();
});
