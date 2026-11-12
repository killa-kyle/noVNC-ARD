import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HpSession} from '../../Sources/ARDWebAssets/Resources/Engine/ard/hp/session.js';
function session() { return new HpSession({nativeMedia:true,sendOffer(){},createSink(){},onState(){}}); }
const ports = new Uint8Array([0,0x24,0,1,0,1,0,0,0,0,0x17,0x0c,0,0,0,1,0x17,0x0d,0,0,0,1,...new Array(16).fill(0)]);
test('native HP refuses nondefault negotiated ports',()=>{
    const hp=session(); hp.handleAnswer(ports); assert.notEqual(hp.state,'failed');
    const changed=ports.slice(); changed[11]=0x0e; hp.handleAnswer(changed);
    assert.equal(hp.state,'failed');
});
test('native HP bounds early encrypted media before keys arrive',()=>{
    const hp=session(); hp.state='offering';
    for(let i=0;i<65;i++) hp._onMedia(new Uint8Array([1,2]).buffer);
    assert.equal(hp.state,'failed'); assert.equal(hp._early.length,0);
});
test('resize completion passes evidence only when explicitly provided by picture callback',()=>{
    const results=[];
    const hp=new HpSession({nativeMedia:true,sendOffer(){},createSink(){},onState(){},
        onResize:(active,result)=>results.push({active,result})});
    hp._resizeSignalled=true; hp._resizeDone();
    assert.deepEqual(results.at(-1),{active:false,result:{confirmed:false}});
    hp._resizeSignalled=true; hp._resizeDone({confirmed:true,width:1200,height:900});
    assert.deepEqual(results.at(-1).result,{confirmed:true,width:1200,height:900});
    const count=results.length; hp._resizeDone(); assert.equal(results.length,count);
});
test('native live RTP and RTCP share packet cap and release async work',async()=>{
    const hp=session(); hp.state='streaming'; const finish=[];
    const decrypt=()=>new Promise(resolve=>finish.push(resolve));
    hp._ctx={videoIn:{unprotectRtp:decrypt,unprotectRtcp:decrypt}};
    const rtp=new Uint8Array(13); rtp[0]=1; rtp[1]=0x80; rtp[2]=96;
    const rtcp=rtp.slice(); rtcp[2]=200;
    for(let i=0;i<64;i++) hp._onMedia((i%2 ? rtcp : rtp).buffer);
    assert.equal(hp._nativeDecryptCount,64); assert.equal(hp._nativeDecryptBytes,64*13);
    hp._onMedia(rtp.buffer); assert.equal(hp.state,'failed');
    await Promise.resolve(); assert.equal(finish.length,64);
    finish.forEach(resolve=>resolve(null));
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(hp._nativeDecryptCount,0); assert.equal(hp._nativeDecryptBytes,0);
});
test('native live media byte cap rejects before scheduling excess decrypt',()=>{
    const hp=session(); hp.state='streaming';
    const release=[]; for(let i=0;i<4;i++) release.push(hp._admitNativeDecrypt(65508));
    assert.equal(hp._nativeDecryptBytes,262032);
    assert.equal(hp._admitNativeDecrypt(200),null); assert.equal(hp.state,'failed');
    release.forEach(fn=>fn()); assert.equal(hp._nativeDecryptBytes,0);
});
