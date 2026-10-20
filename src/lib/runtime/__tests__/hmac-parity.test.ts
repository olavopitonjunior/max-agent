import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {NextRequest} from 'next/server';
import {requireHmac} from '../../auth';
const vector=JSON.parse(readFileSync(new URL('../../../../docs/contracts/max-runtime-v1.json',import.meta.url),'utf8'));
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('runtime HMAC normative wire vectors',()=>{
 it('accepts fixed POST and GET signatures',async()=>{
  vi.stubEnv('MAX_NOTIFY_SECRET',vector.secret);vi.spyOn(Date,'now').mockReturnValue(Number(vector.timestamp));
  const headers={'x-max-timestamp':vector.timestamp,'x-max-signature':vector.post.signature};
  expect((await requireHmac(new NextRequest(`https://max.test${vector.post.path}`,{method:'POST',body:vector.post.rawBody,headers}))).ok).toBe(true);
  expect((await requireHmac(new NextRequest(`https://max.test${vector.get.pathWithQuery}`,{headers:{...headers,'x-max-signature':vector.get.signature}}),{signQuery:true})).ok).toBe(true);
 });
 it.each(['orgId','sessionId','mode'])('rejects POST mutation to signed %s',async key=>{
  vi.stubEnv('MAX_NOTIFY_SECRET',vector.secret);vi.spyOn(Date,'now').mockReturnValue(Number(vector.timestamp));
  const body=JSON.parse(vector.post.rawBody);body[key]='tampered';
  const result=await requireHmac(new NextRequest(`https://max.test${vector.post.path}`,{method:'POST',body:JSON.stringify(body),headers:{'x-max-timestamp':vector.timestamp,'x-max-signature':vector.post.signature}}));expect(result.ok).toBe(false);
 });
 it.each(['orgId','sessionId','mode'])('rejects GET mutation to signed %s',async key=>{
  vi.stubEnv('MAX_NOTIFY_SECRET',vector.secret);vi.spyOn(Date,'now').mockReturnValue(Number(vector.timestamp));
  const url=new URL(`https://max.test${vector.get.pathWithQuery}`);url.searchParams.set(key,'tampered');
  const result=await requireHmac(new NextRequest(url,{headers:{'x-max-timestamp':vector.timestamp,'x-max-signature':vector.get.signature}}),{signQuery:true});expect(result.ok).toBe(false);
 });
});
