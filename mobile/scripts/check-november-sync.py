#!/usr/bin/env python3
"""Exercise the November 1 non-GM-agent contracts on a disposable loopback mock server."""
import json, os, time, urllib.request, urllib.error, urllib.parse
BASE=os.environ.get('ACERCIAE_SYNC_BASE','http://localhost:18087').rstrip('/')
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

gm=call('auth/login',body={'username':'keeper','password':'password'}); t=gm['token']
alice=call('auth/login',body={'username':'alice','password':'password'}); a=alice['token']
server=call('servers',t,{'name':'Mobile November sync '+str(int(time.time()))}); sid=server['id']
call('servers/'+sid+'/settings',t,{'language':'zh-CN','features':{'dice':True,'log_studio':True},'llm':{'provider':'mock'},'image':{'provider':'mock'},'tts':{'provider':'mock'}},'PUT')
channel=call('servers/'+sid+'/channels',t,{'name':'D&D mobile verification','rule_system':'dnd2024','point_buy':True}); root='channels/'+channel['id']
call(root+'/members',t,{'username':'alice','role':'player'})
call(root,t,{'point_buy':True,'ai_enabled':False},'PUT')
w=next(x for x in call(root+'/windows',t) if x['kind']=='main')['id']; win=root+'/windows/'+w
rules=call('dnd/rules',a); assert rules['point_buy']['budget']==27 and len(rules['abilities'])==6
c=call(root+'/characters',a,{'name':'Mobile Rogue','kind':'pc'}); cp=root+'/characters/'+c['id']
d={'class':'Rogue','species':'Elf','background':'Criminal','level':3,'method':'point_buy','base':{'STR':8,'DEX':15,'CON':14,'INT':12,'WIS':12,'CHA':10},'increases':{'DEX':2,'INT':1},'saves':['DEX','INT'],'skills':{'Stealth':2,'Sleight of Hand':1,'Acrobatics':1,'Deception':1,'Investigation':1,'Perception':1,'Insight':1},'ac':14,'hp_max':21}
space=call(cp+'/card',a,{'role_card':{'dnd':d}},'PUT'); assert space['character']['role_card']['dnd']['class']=='Rogue'; assert space['points']['enabled']
# Live damage must survive a later build-only save.
call(win+'/messages',a,{'content':'.st HP:5','kind':'ic','character_id':c['id'],'visibility':'window'})
call(cp+'/card',a,{'role_card':{'dnd':d}},'PUT'); assert call(cp+'/attributes',a)['attrs']['HP']==5
bad={**d,'method':'manual'}; rejected=call(cp+'/card',a,{'role_card':{'dnd':bad}},'PUT',400); assert rejected['error']=='points_rule'
call(win+'/messages',a,{'content':'.ri','kind':'ic','character_id':c['id'],'visibility':'window'})
order=call(win+'/initiative',a); assert len(order['entries'])==1
order=call(win+'/initiative',t,{'action':'next'}); assert order['turn']==order['entries'][0]['id'] and order['round']==1
call(win+'/initiative',a,{'action':'next'},expect=403)
call(win+'/initiative',a,{'action':'remove','entry_id':order['entries'][0]['id']}); assert call(win+'/initiative',a)['entries']==[]
print('PASS D&D rules, validated build, live HP preservation and initiative permissions')
# Read markers are monotonic, viewer-scoped and ignore own messages.
last=call(win+'/messages',t,{'content':'The gate opens.','kind':'narration','visibility':'window'})['seq']
rows=call(root+'/windows',a); assert next(x for x in rows if x['id']==w)['unread']>0
call(win+'/read',a,{'seq':last}); assert next(x for x in call(root+'/windows',a) if x['id']==w)['unread']==0
call(win+'/read',a,{'seq':0}); assert next(x for x in call(root+'/windows',a) if x['id']==w)['unread']==0
call(win+'/messages',a,{'content':'I look around.','kind':'ooc','visibility':'window'}); assert next(x for x in call(root+'/windows',a) if x['id']==w)['unread']==0
print('PASS unread markers, monotonic reads and own-message exclusion')
world=call(root+'/world',a); assert 'entities' in world and 'recent_changes' in world
before=call(win+'/messages',t)
call(root+'/world/declare?observe=false',t,{'text':'The northern gate has been sealed.','secret':True})
assert len(call(win+'/messages',t))==len(before)
call(root+'/world/declare',a,{'text':'Unauthorized declaration'},expect=403)
print('PASS world record visibility and GM-only declarations outside chat')
base=root+'/studio'; status=call(base+'/vn-scripts/status',t); assert 'retry_failed_chunks' in status and status['mock']
job=call(base+'/vn-scripts',t,{'scope':'gm_full','generate_art':False,'retry_failed_chunks':True})
job=wait(base+'/vn-scripts/'+job['id'],'status',{'completed'},t); pid=job['presentation_id']; assert pid
p=base+'/presentations/'+pid
# Background receipt includes missing entries; retry keeps the presentation.
detail=call(base+'/vn-scripts/'+job['id'],t); assert 'background_jobs' in detail
call(base+'/vn-scripts/'+job['id']+'/retry',t,{'retry_failed_chunks':True},expect=400)
if detail['background_jobs']:
 bg=detail['background_jobs'][0]; call(base+'/vn-scripts/'+job['id']+'/backgrounds/retry',t,{'scene_key':bg['scene_key']})
call(win+'/messages',t,{'content':'A bell rings beyond the northern gate.','kind':'narration','visibility':'window'})
continued=call(base+'/vn-scripts',t,{'continue_presentation_id':pid,'generate_art':False})
continued=wait(base+'/vn-scripts/'+continued['id'],'status',{'completed'},t); assert continued['presentation_id']==pid
bundle=call(p+'/bundle',t,{})
for _ in range(120):
 jobs=call(p+'/bundles',t); current=next(x for x in jobs if x['id']==bundle['id'])
 if current['status']=='ready': break
 assert current['status'] not in ('failed','expired'),current
 time.sleep(.5)
else:raise AssertionError('bundle timeout')
request=urllib.request.Request(BASE+'/api/'+base+'/bundles/'+bundle['id']+'/download',headers={'Authorization':'Bearer '+t})
with urllib.request.urlopen(request,timeout=30) as r: assert r.read(4)==b'PK\x03\x04'
print('PASS VN continuation, retry-state guard, missing backgrounds and authenticated asynchronous ZIP download')
for token in (t,a):call('auth/logout',token,{})
