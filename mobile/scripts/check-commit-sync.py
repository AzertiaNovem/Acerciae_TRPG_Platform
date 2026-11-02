#!/usr/bin/env python3
"""Exercise the October 31 non-GM-agent contracts on a disposable loopback mock server."""
import json, os, time, urllib.request, urllib.error, urllib.parse
BASE=os.environ.get('ACERCIAE_SYNC_BASE','http://localhost:18086').rstrip('/')
assert urllib.parse.urlparse(BASE).hostname in ('localhost','127.0.0.1')
def call(path, token='', body=None, method=None, expect=200):
    request=urllib.request.Request(BASE+'/api/'+path, None if body is None else json.dumps(body).encode(), {'Content-Type':'application/json', **({'Authorization':'Bearer '+token} if token else {})},method=method)
    try:
        with urllib.request.urlopen(request,timeout=30) as r:
            assert r.status in (200,201,202),r.status
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code==expect:return json.load(e)
        raise RuntimeError(f'{path}: HTTP {e.code} {e.read().decode()[:200]}') from None

def wait(path, key, accepted, token):
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        value=call(path,token)
        if value.get(key) in accepted:return value
        assert value.get(key)!='failed',value.get('error')
        time.sleep(.25)
    raise AssertionError('Timed out: '+path)

gm=call('auth/login',body={'username':'keeper','password':'password'}); token=gm['token']
server=call('servers',token,{'name':'Mobile commit sync '+str(int(time.time()))}); sid=server['id']
call('servers/'+sid+'/settings',token,{'features':{'consistency':True,'inspiration':True,'atmosphere':True,'log_studio':True,'dice':True},'llm':{'provider':'mock'},'image':{'provider':'mock'},'tts':{'provider':'mock'}},'PUT')
channel=call('servers/'+sid+'/channels',token,{'name':'原生移动端更新验证','rule_system':'coc7','ai_enabled':False}); root='channels/'+channel['id']
windows=call(root+'/windows',token); wid=next(w['id'] for w in windows if w['kind']=='main')
for feature in ('consistency','inspiration','atmosphere'):
    channel=call(root,token,{feature+'_enabled':False},'PUT'); assert channel[feature+'_enabled'] is False
for feature in ('consistency','inspiration'):
    assert call(root+'/'+feature,token,{'chat_window_id':wid,'draft':'查看笔记','hint':'继续调查'},expect=403)['error']=='feature_disabled'
assert call(root+'/atmosphere',token)['enabled'] is False
call(root,token,{'consistency_enabled':True,'inspiration_enabled':True,'atmosphere_enabled':True},'PUT')
print('PASS channel switches: independent gates, 403 prevention contract and atmosphere disable')
module=call(root+'/modules/text',token,{'title':'雨中庭院','text':'调查员来到雨中的旧宅。门厅的日记记载了失踪者最后一封信。守门人藏起钥匙。','async':True})
module=wait(root+'/modules/'+module['id'],'status',{'ready'},token)
again=call(root+'/modules/text',token,{'title':'换标题也不重复','text':'调查员来到雨中的旧宅。门厅的日记记载了失踪者最后一封信。守门人藏起钥匙。','async':True})
assert again['id']==module['id'] and again['deduplicated']
job=call(root+'/script-knowledge/rebuild',token,{'module_id':module['id'],'async':True})
for _ in range(100):
    jobs=call(root+'/script-knowledge/builds',token)
    current=next(j for j in jobs if j['id']==job['id'])
    if current['status']=='completed':break
    assert current['status']!='failed',current.get('error')
    time.sleep(.2)
assert current['status']=='completed'
print('PASS async text import, deduplication and durable knowledge rebuild')
# Minimal valid one-page PDF, generated in memory; no user documents are uploaded.
stream=b"BT /F1 12 Tf 60 700 Td (A porter hides the key to the old manor. The diary holds the missing keeper's last letter.) Tj ET"
objects=[b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Length "+str(len(stream)).encode()+b" >>\nstream\n"+stream+b"\nendstream"]
pdf=b"%PDF-1.4\n"; offsets=[0]
for i, obj in enumerate(objects,1):
    offsets.append(len(pdf)); pdf+=f"{i} 0 obj\n".encode()+obj+b"\nendobj\n"
xref=len(pdf); pdf+=f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
for offset in offsets[1:]:pdf+=f"{offset:010d} 00000 n \n".encode()
pdf+=f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
boundary='mobile-contract-pdf'
body=(f'--{boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nPDF from mobile\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="module.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()+pdf+f'\r\n--{boundary}--\r\n'.encode())
request=urllib.request.Request(BASE+'/api/'+root+'/modules',body,{'Authorization':'Bearer '+token,'Content-Type':'multipart/form-data; boundary='+boundary})
with urllib.request.urlopen(request,timeout=30) as r: uploaded=json.load(r)
wait(root+'/modules/'+uploaded['id'],'status',{'ready'},token)
print('PASS PDF multipart import and background extraction')
status=call(root+'/studio/tts/status',token); assert status['provider']=='mock'
presets=call(root+'/studio/tts/available-voices',token)
voice=call(root+'/studio/voices',token,{'name':'Mock narrator','voice_type':'preset','voice_id':presets[0]['id']})
assert voice['provider']=='mock'
call('servers/'+sid+'/settings',token,{'tts':{'provider':'openai','api_key':'local-test-placeholder-not-a-real-key','model':'gpt-4o-mini-tts','voice':'alloy'}},'PUT')
status=call(root+'/studio/tts/status',token)
assert status['provider']=='openai' and status['features']['voice_clone'] is False
assert [p['key'] for p in status['features']['params']]==['speed']
assert not status['features']['phoneme_dictionary'] and status['features']['instructions']
voice=call(root+'/studio/voices',token,{'name':'OpenAI preset, no synthesis','voice_type':'preset','voice_id':'alloy','model_id':'gpt-4o-mini-tts','language':'zh','synthesis_parameters':{'speed':1.25},'style_instruction':'Warm and measured'})
assert voice['provider']=='openai' and voice['synthesis_parameters']['speed']==1.25
voice=call(root+'/studio/voices/'+voice['id'],token,{'synthesis_parameters':{'speed':.75},'name':'Updated preset'},'PUT')
assert voice['synthesis_parameters']['speed']==.75
call('servers/'+sid+'/settings',token,{'tts':{'provider':'mock','clear_api_key':True}},'PUT')
print('PASS provider capabilities and preset parameter updates; no paid synthesis requested')
call(root+'/scenarios/advance',token,{'title':'成长检定前'})
character=call(root+'/characters',token,{'name':'成长验证调查员','kind':'pc','user_id':gm['user']['id']})
call(root+'/characters/'+character['id']+'/card',token,{'role_card':{'skills':{'Spot Hidden':50}}},'PUT')
for _ in range(20):
    message=call(root+'/windows/'+wid+'/messages',token,{'content':'.ra Spot Hidden 100','character_id':character['id'],'kind':'ic','visibility':'window'})
    if any(r.get('success') for r in message.get('dice',{}).get('rolls',[])):break
else:raise AssertionError('No successful skill check')
call(root+'/scenarios/advance',token,{'title':'成长检定后'})
messages=call(root+'/windows/'+wid+'/messages',token)
assert any(m.get('kind')=='system' and ('成长' in m['content'] or 'development' in m['content']) for m in messages)
space=call(root+'/characters/'+character['id']+'/space',token)
assert space['character']['role_card']['skills']['Spot Hidden']>=50
print('PASS scenario closure publishes growth message and returns current role card')
print('Local preview server:',server['name'])
