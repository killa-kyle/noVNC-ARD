import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeMediaBridge} from '../../Sources/ARDWebAssets/Resources/Engine/native-media.js';
function fixture() {
    let alive = true; const messages = [];
    const bridge = nativeMediaBridge({session:'one', post:m=>messages.push(m), current:()=>alive,
        encode:b=>Buffer.from(b).toString('base64'), decode:s=>new Uint8Array(Buffer.from(s,'base64'))});
    const socket = new bridge.Socket('native-media','ard-media');
    return {bridge,socket,messages, stale:()=>alive=false};
}
test('native open and ordered acknowledgments bound outstanding writes',()=>{
    const {bridge,socket,messages}=fixture();
    assert.equal(messages[0].type,'mediaOpen');
    assert.throws(()=>socket.send(new Uint8Array([1,1])));
    bridge.opened(); socket.send(new Uint8Array([1,1])); socket.send(new Uint8Array([0,2]));
    assert.equal(messages.filter(m=>m.type==='mediaWrite').length,1);
    assert.throws(()=>bridge.ack(5)); bridge.ack(1);
    assert.equal(messages.filter(m=>m.type==='mediaWrite').length,2);
    bridge.ack(2); assert.equal(socket.bufferedAmount,0);
});
test('datagrams reject invalid channels and oversize before dispatch',()=>{
    const {bridge,socket,messages}=fixture(); bridge.opened();
    for (const data of [new Uint8Array([2,1]),new Uint8Array([1]),new Uint8Array(65509)])
        assert.throws(()=>socket.send(data));
    assert.equal(messages.length,1);
    assert.throws(()=>bridge.receive('A'.repeat(87345)));
});
test('backpressure closes without discarding an open session silently',()=>{
    const {bridge,socket,messages}=fixture(); bridge.opened();
    for(let i=0;i<64;i++) socket.send(new Uint8Array([1,4]));
    assert.throws(()=>socket.send(new Uint8Array([1,4])));
    assert.equal(socket.readyState,3); assert.equal(socket.bufferedAmount,0);
    assert.equal(messages.at(-1).type,'mediaClose');
});
test('receive is copied, session-bound and teardown is idempotent',()=>{
    const {bridge,socket,messages,stale}=fixture(); bridge.opened(); let received;
    socket.onmessage=ev=>received=new Uint8Array(ev.data);
    bridge.receive(Buffer.from([1,8,9]).toString('base64')); assert.deepEqual([...received],[1,8,9]);
    stale(); assert.throws(()=>bridge.receive('AQI=')); assert.throws(()=>bridge.ack(1));
    bridge.close(); bridge.close(); assert.equal(messages.filter(m=>m.type==='mediaClose').length,1);
});
