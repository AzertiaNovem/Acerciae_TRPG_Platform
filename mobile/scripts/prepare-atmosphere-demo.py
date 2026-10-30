#!/usr/bin/env python3
"""Prepare only a loopback mock atmosphere for native visual/contract checks."""
import json, os, time, urllib.request, urllib.parse
BASE=os.environ.get('ACERCIAE_ATMOSPHERE_BASE','http://localhost:18085').rstrip('/')
assert urllib.parse.urlparse(BASE).hostname in ('localhost','127.0.0.1')
def call(path, token='', body=None, method=None):
    with urllib.request.urlopen(urllib.request.Request(BASE+'/api/'+path, None if body is None else json.dumps(body).encode(), {'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})},method=method),timeout=20) as r:return json.load(r)
gm=call('auth/login',body={'username':'keeper','password':'password'}); t=gm['token']
call('auth/me',t,{'atmosphere_enabled':True,'ui_language':'zh-CN'},'PUT')
servers=call('servers',t); server=next((s for s in servers if s['name']=='Mobile atmosphere preview'),None)
if server is None:
    server=call('servers',t,{'name':'Mobile atmosphere preview'})
    call('servers/'+server['id']+'/settings',t,{'language':'zh-CN','features':{'atmosphere':True},'image':{'provider':'mock'}},'PUT')
    channel=call('servers/'+server['id']+'/channels',t,{'name':'雨中的庭院','knowledge_mode':'isolated'})
    root='channels/'+channel['id']; call(root+'/members',t,{'username':'alice','role':'player'})
    window=call(root+'/windows',t)[0]['id']
    for content in ['石墙上爬满常春藤，细雨落在庭院的青石板上。','远处的铁门半掩着，积水映出摇曳的树枝。','[Atmosphere] 雨中的常春藤庭院']:
        call(root+'/windows/'+window+'/messages',t,{'content':content,'kind':'narration','visibility':'window'})
    call(root+'/ai/observe-now',t,{},'POST')
else: channel=call('servers/'+server['id']+'/channels',t)[0]; root='channels/'+channel['id']
for _ in range(80):
    current=call(root+'/atmosphere',t)
    if len(current.get('assets',{}))==4:break
    time.sleep(.5)
else:raise RuntimeError('Mock four-image set did not complete')
assert current.get('mock') is True
print('Prepared local mock channel:',channel['id'])
