import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
const config = () => ({session:'adaptive',identity:'fixed-host:5900',nativeMedia:true,
    adaptiveDesktop:{enabled:true,privateSession:true,width:1024,height:768,scale:1}});
test('ordinary connect retains HP disabled and no media authority',()=>{
    const {rfb,messages}=fixture(); assert.equal(rfb._ardHpAllowed,false);
    assert.equal(rfb._ardHpNativeSocket,undefined);
    assert.equal(messages.some(m=>m.type==='mediaOpen'),false);
});
test('optional mode fails closed without direct native private Control and HEVC',async()=>{
    const {api}=fixture();
    await assert.rejects(api.connect(config()),/decoder unavailable/);
    for (const changes of [{viewOnly:true},{transportTrusted:true},{nativeMedia:false},
        {adaptiveDesktop:{...config().adaptiveDesktop,privateSession:false}},
        {adaptiveDesktop:{...config().adaptiveDesktop,width:99999}}])
        await assert.rejects(api.connect({...config(),...changes}));
});
test('explicit optional mode injects native socket and resize gates state',async()=>{
    const {api,instances}=fixture({VideoDecoder:{isConfigSupported:async()=>({supported:true})}});
    await api.connect(config()); const rfb=instances.at(-1);
    assert.equal(rfb._ardHpAllowed,true); assert.equal(rfb._ardQualityPreset,'highperf');
    assert.equal(rfb._ardHpMediaUrl,'native-media'); assert.equal(typeof rfb._ardHpNativeSocket,'function');
    assert.equal(api.resizeDesktop('adaptive',1000,800),true);
    rfb._rfbConnectionState='connected'; rfb._ardHp={state:'streaming'};
    rfb.ardOnVirtualDisplay=()=>true; rfb._ardHpResize=()=>true;
    assert.equal(api.resizeDesktop('adaptive',1000,800),true);
    assert.equal(api.resizeDesktop('adaptive',1002,800),true,'latest request is queued');
    api.observe('adaptive',true); rfb.viewOnly=true; assert.equal(api.resizeDesktop('adaptive',1000,800),false);
    assert.throws(()=>api.selectSession('adaptive',1),/private/);
    assert.throws(()=>api.resizeDesktop('old',1000,800),/Stale/);
});
test('resize settlement distinguishes decoded host size from timeout or unknown result',async()=>{
    const {api,instances,messages}=fixture({VideoDecoder:{isConfigSupported:async()=>({supported:true})}});
    await api.connect(config()); const rfb=instances.at(-1);
    rfb._ardHp={state:'streaming'}; rfb.ardOnVirtualDisplay=()=>true;
    const settle=detail=>rfb.listeners.ardhpresize({detail});
    const status=()=>messages.filter(m=>m.event==='adaptiveDesktop').at(-1).detail;
    settle({active:false});
    assert.equal(status().resizePending,false); assert.equal(status().confirmed,false);
    assert.equal(status().width,undefined); assert.match(status().status,/without a confirmed/);
    settle({active:false,confirmed:true,width:1234,height:876});
    assert.equal(status().confirmed,true); assert.equal(status().width,1234);
    assert.match(status().status,/1234 × 876/);
    settle({active:false,confirmed:true,width:Infinity,height:876});
    assert.equal(status().confirmed,false); assert.equal(status().width,undefined);
});
