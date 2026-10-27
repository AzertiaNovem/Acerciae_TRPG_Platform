#include "VnBundle.h"
#include "../core/Json.h"

namespace acerciae::logstudio {
namespace {
const char* kTemplate = R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__VN_TITLE__</title>
<style>
:root { --accent: __VN_ACCENT__; --panel: rgba(12, 14, 20, .82); --text: #f4f1ea; --muted: #b9b4a8; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #07080c; color: var(--text); font-family: "Noto Serif", Georgia, serif; }
body.font-sans { font-family: "Noto Sans", "Segoe UI", system-ui, sans-serif; }
body.font-mono { font-family: "JetBrains Mono", Consolas, monospace; }
#stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: #07080c center/cover no-repeat; transition: background-image .4s ease; user-select: none; }
#stage::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.55), transparent 45%); pointer-events: none; }
#cast { position: absolute; inset: 0 0 20% 0; display: flex; align-items: flex-end; justify-content: center; pointer-events: none; }
#cast img { position: absolute; bottom: 0; max-height: 92%; max-width: 40%; object-fit: contain; filter: brightness(.55); transition: filter .25s, transform .25s; }
#cast img.active { filter: brightness(1); transform: translateY(-6px); z-index: 2; }
#cast img.pos-left { left: 6%; } #cast img.pos-center { left: 50%; transform: translateX(-50%); } #cast img.pos-center.active { transform: translateX(-50%) translateY(-6px); } #cast img.pos-right { right: 6%; }
#box { position: absolute; left: 50%; bottom: 4%; transform: translateX(-50%); width: min(92%, 980px); background: var(--panel); border: 1px solid rgba(255,255,255,.12); border-top: 3px solid var(--accent); border-radius: 10px; padding: 18px 24px 22px; min-height: 140px; z-index: 3; backdrop-filter: blur(6px); }
#speaker { font-weight: 700; color: var(--accent); letter-spacing: .04em; margin-bottom: 6px; min-height: 1.2em; }
#text { font-size: 1.1rem; line-height: 1.6; white-space: pre-wrap; }
#text.narration { font-style: italic; color: var(--muted); }
#text.dice { font-family: "JetBrains Mono", Consolas, monospace; color: #ffd27a; }
#hud { position: absolute; top: 10px; right: 12px; display: flex; gap: 8px; z-index: 4; font-family: system-ui, sans-serif; font-size: 13px; }
#hud button, #hud select { background: rgba(0,0,0,.55); color: var(--text); border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 5px 9px; cursor: pointer; }
#hud button.on { border-color: var(--accent); color: var(--accent); }
#title { position: absolute; top: 12px; left: 14px; font-size: 13px; color: var(--muted); z-index: 4; font-family: system-ui, sans-serif; }
#progress { position: absolute; bottom: 0; left: 0; height: 3px; background: var(--accent); z-index: 5; transition: width .2s; }
#scene-card { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.75); z-index: 6; font-size: 2rem; letter-spacing: .12em; text-transform: uppercase; }
#scene-card.show { display: flex; animation: fade 1.4s ease forwards; }
@keyframes fade { 0% { opacity: 0 } 20% { opacity: 1 } 80% { opacity: 1 } 100% { opacity: 0; visibility: hidden } }
body.tpl-nvl #box { top: 6%; bottom: 6%; min-height: 0; overflow: auto; } body.tpl-nvl #cast img { filter: brightness(.35); }
body.tpl-dossier { --panel: rgba(28, 24, 18, .92); } body.tpl-dossier #box { border-radius: 2px; border-top-width: 1px; }
body.tpl-cinematic #box { background: transparent; border: none; text-align: center; text-shadow: 0 2px 8px #000; backdrop-filter: none; }
#end { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; flex-direction: column; gap: 12px; background: rgba(0,0,0,.8); z-index: 7; }
#end.show { display: flex; }
</style>
</head>
<body>
<div id="stage">
  <div id="title">__VN_TITLE__</div>
  <div id="hud">
    <select id="jump" title="Scene"></select>
    <button id="auto" title="Auto-play (A)">Auto</button>
    <button id="mute" title="Mute (M)">Sound</button>
    <button id="full" title="Fullscreen (F)">Fullscreen</button>
  </div>
  <div id="cast"></div>
  <div id="box"><div id="speaker"></div><div id="text"></div></div>
  <div id="scene-card"></div>
  <div id="end"><div>— End —</div><button id="replay">Replay</button></div>
  <div id="progress"></div>
</div>
<script id="vn-data" type="application/json">__VN_DATA__</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('vn-data').textContent);
  var events = data.events || [], scenes = data.scenes || [];
  var sceneById = {}; scenes.forEach(function(s){ sceneById[s.id] = s; });
  var tpl = data.template || {};
  document.body.classList.add('tpl-' + (tpl.layout || tpl.id || 'adv'));
  if (tpl.font) document.body.classList.add('font-' + tpl.font);
  var i = -1, typing = null, auto = false, muted = false, audio = null, lastScene = null;
  var $ = function(id){ return document.getElementById(id); };
  var stage = $('stage'), cast = $('cast'), speakerEl = $('speaker'), textEl = $('text'), card = $('scene-card');
  scenes.forEach(function(s, n){ var o = document.createElement('option'); o.value = s.id; o.textContent = (n + 1) + '. ' + (s.title || 'Scene'); $('jump').appendChild(o); });
  function stopAudio(){ if (audio) { audio.pause(); audio = null; } }
  function show(n){
    if (n < 0) n = 0;
    if (n >= events.length) { $('end').classList.add('show'); auto = false; $('auto').classList.remove('on'); return; }
    $('end').classList.remove('show');
    i = n; var e = events[n]; var sc = sceneById[e.scene_id];
    if (sc && sc.id !== lastScene) {
      lastScene = sc.id; $('jump').value = sc.id;
      stage.style.backgroundImage = sc.background ? 'url("' + sc.background + '")' : 'none';
      if (e.kind === 'scene_change' || n === 0) { card.textContent = sc.title || ''; card.classList.remove('show'); void card.offsetWidth; card.classList.add('show'); }
    }
    cast.innerHTML = '';
    (e.stage || []).forEach(function(c){ if (!c.image) return; var img = document.createElement('img'); img.src = c.image; img.alt = c.name || ''; img.className = 'pos-' + (c.position || 'center') + (c.active ? ' active' : ''); cast.appendChild(img); });
    speakerEl.textContent = e.speaker || '';
    textEl.className = e.kind || '';
    var full = e.text || ''; if (e.dice && e.dice.total != null) full += '  [' + e.dice.total + (e.dice.outcome ? ' · ' + e.dice.outcome : '') + ']';
    if (typing) clearInterval(typing);
    textEl.textContent = ''; var k = 0;
    typing = setInterval(function(){ k += 2; textEl.textContent = full.slice(0, k); if (k >= full.length) { clearInterval(typing); typing = null; if (auto && !audio) setTimeout(function(){ if (auto && i === n) show(n + 1); }, 900 + full.length * 25); } }, 16);
    stopAudio();
    if (e.audio && !muted) { audio = new Audio(e.audio); audio.onended = function(){ audio = null; if (auto && i === n) show(n + 1); }; audio.play().catch(function(){ audio = null; }); }
    $('progress').style.width = ((n + 1) / events.length * 100) + '%';
  }
  function next(){ if (typing) { clearInterval(typing); typing = null; var e = events[i]; textEl.textContent = (e.text || '') + (e.dice && e.dice.total != null ? '  [' + e.dice.total + (e.dice.outcome ? ' · ' + e.dice.outcome : '') + ']' : ''); return; } show(i + 1); }
  stage.addEventListener('click', function(ev){ if (ev.target.closest('#hud') || ev.target.closest('#end')) return; next(); });
  document.addEventListener('keydown', function(ev){
    if (ev.key === ' ' || ev.key === 'ArrowRight' || ev.key === 'Enter') { ev.preventDefault(); next(); }
    else if (ev.key === 'ArrowLeft') show(i - 1);
    else if (ev.key.toLowerCase() === 'a') $('auto').click();
    else if (ev.key.toLowerCase() === 'm') $('mute').click();
    else if (ev.key.toLowerCase() === 'f') $('full').click();
  });
  $('auto').onclick = function(){ auto = !auto; this.classList.toggle('on', auto); if (auto && !typing && !audio) show(i + 1); };
  $('mute').onclick = function(){ muted = !muted; this.classList.toggle('on', muted); this.textContent = muted ? 'Muted' : 'Sound'; if (muted) stopAudio(); };
  $('full').onclick = function(){ if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); };
  $('jump').onchange = function(){ var id = this.value; for (var n = 0; n < events.length; n++) if (events[n].scene_id === id) { lastScene = null; show(n); return; } };
  $('replay').onclick = function(){ lastScene = null; show(0); };
  show(0);
})();
</script>
</body>
</html>
)HTML";

std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
  for (size_t p = s.find(from); p != std::string::npos; p = s.find(from, p + to.size())) s.replace(p, from.size(), to);
  return s;
}
std::string escapeHtml(const std::string& s) {
  std::string o;
  for (char c : s) {
    switch (c) {
      case '&': o += "&amp;"; break; case '<': o += "&lt;"; break; case '>': o += "&gt;"; break; case '"': o += "&quot;"; break;
      default: o += c;
    }
  }
  return o;
}
} // namespace

std::string renderStandaloneVn(const Json::Value& data) {
  std::string accent = data["template"]["accent"].isString() ? data["template"]["accent"].asString() : "#c9a35c";
  // Only a CSS colour literal may reach the stylesheet.
  bool ok = !accent.empty() && accent.size() <= 24;
  for (char c : accent) ok = ok && (isalnum((unsigned char)c) || c == '#' || c == '(' || c == ')' || c == ',' || c == '.' || c == '%' || c == ' ');
  if (!ok) accent = "#c9a35c";
  auto payload = replaceAll(json::dump(data, false), "</", "<\\/");
  std::string html = replaceAll(kTemplate, "__VN_TITLE__", escapeHtml(data["title"].asString()));
  html = replaceAll(html, "__VN_ACCENT__", accent);
  return replaceAll(html, "__VN_DATA__", payload);
}
} // namespace acerciae::logstudio
