#!/usr/bin/env python3
"""Exercise mobile contracts on a dedicated local, seeded mock backend (default :18082).
Creates test messages, scenarios and a replay; never use against a real campaign.
"""
import json, os, time, urllib.request, urllib.error, urllib.parse
base = os.environ.get('ACERCIAE_TEST_BASE', 'http://localhost:18082').rstrip('/')
assert urllib.parse.urlparse(base).hostname in ('localhost', '127.0.0.1'), 'Local test server only'
def call(path, token=None, body=None, method=None, raw=False):
    request = urllib.request.Request(base + '/api/' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer '+token} if token else {})}, method=method)
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read()
        return data if raw else json.loads(data)
def login(name): return call('auth/login', body={'username':name, 'password':'password'})
assert call('health')['llm_mode'] == 'mock'
gm, alice, bob = (login(name) for name in ('keeper','alice','bob'))
g, a, b = (s['token'] for s in (gm,alice,bob))
server = call('servers', g)[0]
channel = call('servers/'+server['id']+'/channels', g)[0]
root = 'channels/'+channel['id']; studio = root+'/studio'
assert call(studio+'/tts/status',g)['provider']=='mock'
windows = call(root+'/windows',a); window=next(w for w in windows if w['kind']=='main')
assert not any(w['kind']=='private' for w in windows)
characters=call(root+'/characters',a); own=next(c for c in characters if c['user_id']==alice['user']['id'])
assert all(c['kind']=='pc' for c in characters)
p=root+'/windows/'+window['id']+'/messages'
before=call(p,a)
preview=call(root+'/dice/preview',a,{'content':'.ra 侦查 55','chat_window_id':window['id'],'character_id':own['id']})
assert preview['hint'] and before==call(p,a)
rolled=call(p,a,{'content':'.r 1d1 mobile-contract','kind':'ic','character_id':own['id']})
assert rolled['kind']=='roll' and rolled['dice']['text'] and rolled['author_id']==alice['user']['id']
hidden=call(p,a,{'content':'.rh 1d1 mobile-private','kind':'ic','character_id':own['id']})
bob_rows=call(p,b)
assert hidden['id'] not in [m['id'] for m in bob_rows]
assert any(m.get('dice',{}).get('type')=='hidden_notice' for m in bob_rows if isinstance(m.get('dice'),dict))
assert not any(m.get('dice',{}).get('hidden') for m in bob_rows if isinstance(m.get('dice'),dict))
older=call(p+'?limit=2&before_seq='+str(rolled['seq']),a)
assert all(m['seq']<rolled['seq'] for m in older)
settings=call('servers/'+server['id']+'/settings',a)
assert not settings['is_maintainer']
try:
    call('servers/'+server['id']+'/settings',a,{'features':{'dice':False}},'PUT')
    raise AssertionError('Player setting write was allowed')
except urllib.error.HTTPError as e: assert e.code==403
check=call(root+'/consistency',a,{'chat_window_id':window['id'],'character_id':own['id'],'draft':'The Sheriff promised us the lighthouse key.'})
assert check['insufficient_evidence'] or isinstance(check['score'],int)
inspiration=call(root+'/inspiration',a,{'chat_window_id':window['id'],'character_id':own['id']})
assert inspiration['draft'] and inspiration['auto_sent'] is False
project=call(studio+'/log',g)['project']
snapshot=call(studio+'/projects/'+project['id']+'/snapshots',g,{'title':'公开回放 · 移动端验证','scope':'pl_public'})
canonical=call(studio+'/snapshots/'+snapshot['id'],a)
assert not any(e.get('metadata',{}).get('dice_result',{}).get('hidden') for e in canonical['events'])
snapshot=call(studio+'/projects/'+project['id']+'/snapshots',g,{'title':'哈维视角 · 移动端验证','scope':'character','scope_character_id':own['id']})
try:
    call(studio+'/snapshots/'+snapshot['id'],b)
    raise AssertionError('Other character snapshot was readable')
except urllib.error.HTTPError as e: assert e.code in (403,404)
presentation=call(studio+'/snapshots/'+snapshot['id']+'/presentations',g,{'title':'黑水湾 · 原生回放'})
voice=call(studio+'/voices',g,{'name':'移动端示例配音','voice_type':'preset','voice_id':'mock-serena'})
line=next(e for e in presentation['events'] if not e['hidden'] and e['display_kind'] in ('dialogue','narration') and e['display_text'])
call(studio+'/pevents/'+line['id'],g,{'voice_profile_id':voice['id']},'PUT')
job=call(studio+'/presentations/'+presentation['id']+'/tts/jobs',g,{'scope':{'event_ids':[line['id']]}})
for _ in range(30):
    status=call(studio+'/tts/jobs/'+job['id'],g)
    if status['status'] in ('completed','failed'): break
    time.sleep(.5)
assert status['status']=='completed', status['status']
read=call(studio+'/presentations/'+presentation['id'],a)
voiced=next(e for e in read['events'] if e['id']==line['id'])
assert voiced['audio_asset_id'] and voiced['audio_is_mock']
assert len(call(studio+'/tts/audio/'+voiced['audio_asset_id'],a,raw=True))>44
call(studio+'/presentations/'+presentation['id']+'/progress',a,{'position':1})
assert call(studio+'/presentations/'+presentation['id']+'/progress',a)['position']==1
for format in ('json','txt','html','zip'):
    assert call(studio+'/log/export?format='+format,a,raw=True)
sealdice=call(studio+'/log/export?format=sealdice&chat_window_id='+window['id'],a)
assert sealdice['version']==105 and isinstance(sealdice['items'],list)
# New member-specific context never exposes the Keeper board.
assert isinstance(call(root+'/reminders',a),list)
for path in ('kp/board','script-knowledge'):
    try:
        call(root+'/'+path,a); raise AssertionError('Player can read Keeper material')
    except urllib.error.HTTPError as e: assert e.code==403
assert 'next' in call(root+'/kp/board',g)
space=call(root+'/characters/'+own['id']+'/space',a)
assert space['character']['editable']
card=space['character']['role_card']; card['basic']['occupation']='调查员'
updated=call(root+'/characters/'+own['id']+'/card',a,{'role_card':card},'PUT')
assert updated['character']['role_card']['basic']['occupation']=='调查员'
try:
    call(root+'/characters/'+own['id']+'/card',b,{'bio':'not allowed'},'PUT')
    raise AssertionError('Other player edited role card')
except urllib.error.HTTPError as e: assert e.code==403
# Every window moves together; closed scenarios cannot be re-entered.
old=call(root,a)['current_scene_id']
next_scene=call(root+'/scenarios/advance',g,{'title':'移动端联调阶段','location':'黑水湾','narrative_time':'翌日'})['scene']
assert all(w['active_scene_id']==next_scene['id'] for w in call(root+'/windows',g))
try:
    call(root+'/scenarios/enter',g,{'scene_id':old}); raise AssertionError('Closed scene was reopened')
except urllib.error.HTTPError as e: assert e.code==409
# A player creates a novel limited to their own character, then casts and exports it.
vn=call(studio+'/vn-scripts',a,{'scope':'character','scope_character_id':own['id'],'title':'移动端视觉小说','template':{'base':'adv'},'generate_art':False})
for _ in range(60):
    vn=call(studio+'/vn-scripts/'+vn['id'],a)
    if vn['status'] in ('completed','failed','cancelled'): break
    time.sleep(.5)
assert vn['status']=='completed',vn
pres=call(studio+'/presentations/'+vn['presentation_id']+'/cast',a,{'cast':{'narrator':voice['id'],own['id']:voice['id']}})
estimate=call(studio+'/presentations/'+pres['id']+'/tts/estimate',a,{})
assert estimate['mock'] and estimate['within_budget']
assert call(studio+'/presentations/'+pres['id']+'/bundle.zip',a,raw=True).startswith(b'PK')
# Switches are enforced by the server and can be restored outside Studio.
call(root,g,{'studio_visible':False},'PUT')
try:
    call(studio+'/log',a); raise AssertionError('Hidden Studio was readable')
except urllib.error.HTTPError as e: assert e.code==403
finally: call(root,g,{'studio_visible':True},'PUT')
print('PASS: privacy, dice, AI drafts, character card permissions, global scenarios, reminders/KP isolation, campaign exports, player VN, cast/estimate/bundle, Studio switches, audio/progress')
print(json.dumps({'server_id':server['id'],'channel_id':channel['id'],'project_id':project['id'],'snapshot_id':snapshot['id'],'presentation_id':presentation['id']},ensure_ascii=False))
for session in (g,a,b): call('auth/logout',session,{})
