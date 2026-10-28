#!/usr/bin/env python3
"""Exercise b865e94 contracts against a disposable, loopback-only seeded service."""
import json, os, urllib.request, urllib.error, urllib.parse, uuid
BASE=os.environ.get('ACERCIAE_SYNC_BASE','http://localhost:18084').rstrip('/')
assert urllib.parse.urlparse(BASE).hostname in ('localhost','127.0.0.1'), 'Only a local disposable service is allowed'
def call(path,token='',body=None,method=None,expected=200):
    req=urllib.request.Request(BASE+'/api/'+path, None if body is None else json.dumps(body).encode(), {'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})}, method=method)
    try:
        with urllib.request.urlopen(req,timeout=20) as r: status=r.status; data=json.load(r)
    except urllib.error.HTTPError as e: status=e.code; data=json.load(e)
    assert status==expected, (path,status,data)
    return data
keeper=call('auth/login',body={'username':'keeper','password':'password'})
alice=call('auth/login',body={'username':'alice','password':'password'})
bob=call('auth/login',body={'username':'bob','password':'password'})
carol=call('auth/login',body={'username':'carol','password':'password'})
k,a,b,c=(x['token'] for x in (keeper,alice,bob,carol))
server=call('servers',k,{'name':'Mobile sync contract '+uuid.uuid4().hex[:8]}); sid=server['id']; sp='servers/'+sid
try:
    call(sp+'/settings',k,{'policy':{'join_policy':'open','channel_creation':'members','guest_invites':True,'main_chat_spectators':True}},'PUT')
    assert any(x['id']==sid for x in call('server-directory',a))
    call(sp+'/join',a,{}); call(sp+'/join',b,{})
    configured=call(sp+'/settings',k,{'llm':{'provider':'mock','api_key':'local-fixture-key'},'ai_policy':{'token_budget':12345,'image_budget':42,'period':'total','max_concurrent':2}},'PUT')
    assert configured['llm']['api_key_set'] and 'api_key' not in configured['llm']
    preserved=call(sp+'/settings',k,{'llm':{'api_key':''}},'PUT')
    assert preserved['llm']['api_key_set']
    assert 'llm' not in call(sp+'/settings',a)
    cleared=call(sp+'/settings',k,{'llm':{'clear_api_key':True}},'PUT')
    assert not cleared['llm']['api_key_set']
    ch=call(sp+'/channels',a,{'name':'Mobile contract','knowledge_mode':'isolated','rule_system':'coc7e'}); cp='channels/'+ch['id']
    call(cp+'/members',a,{'username':'carol','role':'player'})
    assert next(x for x in call('servers',c) if x['id']==sid)['my_role']=='guest'
    call(sp+'/channels',c,{'name':'Forbidden'},expected=403)
    call(sp+'/settings',k,{'policy':{'channel_creation':'maintainers'}},'PUT')
    call(sp+'/channels',a,{'name':'Forbidden'},expected=403)
    win=call(cp+'/windows',a)[0]['id']
    call(cp+'/windows/'+win+'/messages',a,{'content':'Public mobile contract line','kind':'ooc'})
    spectator=call(cp+'/spectate',b)
    assert any(x['content']=='Public mobile contract line' for x in spectator['messages'])
    assert all(x.get('character_avatar_asset_id') is None for x in spectator['messages'])
    call(cp+'/spectate',c,expected=403)
    call(cp,a,{'studio_visible':True,'studio_player_access':False},'PUT')
    call(cp+'/studio/log',c,expected=403)
    call(cp+'/story/end',a,{'reveal_keeper_lines':False})
    call(cp+'/studio/log',c)
    call(cp+'/story/reopen',a,{})
    call(cp+'/studio/log',c,expected=403)
    call(sp+'/settings',k,{'policy':{'join_policy':'invite'}},'PUT')
    invite=call(sp+'/invites',k,{'max_uses':1,'expires_in_hours':1})
    assert call('invites/'+invite['code'],b)['valid']
    call(sp+'/invites/'+invite['id'],k,method='DELETE')
    assert not call('invites/'+invite['code'],b)['valid']
    call(cp,a,{'confirm':'Delete Channel'},'DELETE',403) # GM alone is not a server maintainer.
    call(cp,k,{'confirm':'wrong'},'DELETE',400)
    call(cp,k,{'confirm':'Delete Channel'},'DELETE')
    assert all(x['id']!=ch['id'] for x in call(sp+'/all-channels',k))
    call(sp,a,{'confirm':'Delete Server'},'DELETE',403)
    call(sp,k,{'confirm':'wrong'},'DELETE',400)
    print('PASS: joins, channel policies, guest/spectator boundaries, story access, invite revocation, typed deletion permissions')
finally:
    call(sp,k,{'confirm':'Delete Server'},'DELETE')
