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
