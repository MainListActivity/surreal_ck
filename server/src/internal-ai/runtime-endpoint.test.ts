import {expect,test} from 'bun:test';
import {runtimeEndpoint} from './runtime-endpoint';
import {tariffFor} from './pricing';
test('runtime metadata never exposes credentials/query/fragment and refuses remote plaintext',()=>{
 for(const url of ['https://user:secret@example.com/v1','https://example.com/v1?key=secret','https://example.com/v1#secret','http://remote.test/v1',undefined])expect(runtimeEndpoint(url)).toBeNull();
 expect(runtimeEndpoint('https://data.maplayer.top/ofm/v1')?.path).toBe('/ofm/v1');
 expect(runtimeEndpoint('http://[::1]:3425/v1')?.host).toBe('[::1]');
 expect(tariffFor('openai','group/work','http://127.0.0.1:3425/v1')).toBeUndefined();
});
