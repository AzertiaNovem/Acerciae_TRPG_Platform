import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.API_BASE || 'http://127.0.0.1:18081';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OSAAAAAASUVORK5CYII=';
async function request(token, method, path, body, status = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data)); return data;
}
test('Personal profile: all server languages, atomic rename, persistent avatar and account isolation', async () => {
  const suffix = Date.now().toString(36);
  const make = name => request(null, 'POST', '/api/auth/register', {username: name + suffix, display_name: name, password:'password'});
  const a = await make('profile_a'), b = await make('profile_b');
  const server = await request(a.token, 'POST', '/api/servers', {name:'Profile test'});
  const settings = await request(a.token, 'GET', `/api/servers/${server.id}/settings`);
  const me = await request(a.token, 'GET', '/api/auth/me');
  assert.deepEqual(me.languages, settings.languages); assert.equal(me.languages.length, 11);
  await request(null, 'PUT', '/api/auth/me', {display_name:'bad'}, 401);
  for (const language of me.languages) {
    const updated = await request(a.token, 'PUT', '/api/auth/me', {ui_language: language});
    assert.equal(updated.ui_language, language);
    const login = await request(null, 'POST', '/api/auth/login', {username: me.username, password:'password'});
    assert.equal(login.user.ui_language, language);
    await request(login.token, 'POST', '/api/auth/logout');
  }
  await request(a.token, 'PUT', '/api/auth/me', {ui_language:'xx'}, 400);
  await request(a.token, 'PUT', '/api/auth/me', {user_id:b.user.id, display_name:'hijack'}, 400);
  await request(a.token, 'PUT', '/api/auth/me', {display_name:'   '}, 400);
  await request(a.token, 'PUT', '/api/auth/me', {username:b.user.username, display_name:'must roll back'}, 409);
  assert.equal((await request(a.token, 'GET', '/api/auth/me')).display_name, me.display_name);
  for (const data of ['https://example.com/x.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,bm90IGFuIGltYWdl', png + 'junk'])
    await request(a.token, 'PUT', '/api/auth/me', {avatar_data:data}, 400);
  await request(a.token, 'PUT', '/api/auth/me', {avatar_data: 'data:image/png;base64,'+'A'.repeat(180001)}, 400);
  const renamed = 'renamed_' + suffix;
  const profile = await request(a.token, 'PUT', '/api/auth/me', {username:renamed,display_name:'夜雨调查员',avatar_data:png,ui_language:'zh-CN'});
  assert.equal(profile.avatar_data, png); assert.equal(profile.avatar_version, 1); assert.equal(profile.id, me.id);
  const avatarPath = `/api/users/${me.id}/avatar`;
  assert.equal((await fetch(base+avatarPath)).status,401);
  assert.equal((await fetch(base+avatarPath,{headers:{Authorization:`Bearer ${b.token}`}})).status,404);
  await request(a.token,'POST',`/api/servers/${server.id}/members`,{user_id:b.user.id});
  const image = await fetch(base+avatarPath,{headers:{Authorization:`Bearer ${b.token}`}});
  assert.equal(image.status,200); assert.equal(image.headers.get('content-type'),'image/png');
  assert.equal(image.headers.get('x-content-type-options'),'nosniff'); assert.match(image.headers.get('cache-control'),/no-store/);
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'),png.split(',')[1]);
  await request(null,'POST','/api/auth/login',{username:me.username,password:'password'},401);
  const login = await request(null,'POST','/api/auth/login',{username:renamed,password:'password'});
  assert.equal(login.user.ui_language,'zh-CN'); assert.equal(login.user.avatar_data,png); assert.equal(login.user.display_name,'夜雨调查员');
  const retained = await request(a.token,'GET',`/api/servers/${server.id}/settings`);
  assert.equal(retained.language,settings.language); assert.equal(retained.is_maintainer,true);
  const other = await request(b.token,'GET','/api/auth/me'); assert.equal(other.username,b.user.username); assert.equal(other.avatar_data,''); assert.equal(other.ui_language,'en');
  await request(a.token,'PUT','/api/auth/me',{avatar_data:''});
  assert.equal((await fetch(base+avatarPath,{headers:{Authorization:`Bearer ${b.token}`}})).status,404);
});
