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
