import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.mjs';

test('flush waits until every queued chunk has been acknowledged by native transport', async () => {
    const { api, rfb, messages } = fixture();
    rfb.channel.readyState = 'open';
    rfb.channel.send(new Uint8Array([1, 2]));
    rfb.channel.send(new Uint8Array([3, 4]));
    let finished = false;
    const pending = api.flush('test-session').then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(finished, false);
    let writes = messages.filter(message => message.type === 'write');
    assert.equal(writes.length, 1);
    api.ack('test-session', writes[0].sequence);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(finished, false);
    writes = messages.filter(message => message.type === 'write');
    assert.equal(writes.length, 2);
    api.ack('test-session', writes[1].sequence);
    assert.equal(await pending, true);
});

test('flush reports closure rather than claiming unsent bytes were delivered', async () => {
    const { api, rfb } = fixture();
    rfb.channel.readyState = 'open';
    rfb.channel.send(new Uint8Array([1]));
    const pending = api.flush('test-session');
    rfb.channel.close();
    assert.equal(await pending, false);
});
