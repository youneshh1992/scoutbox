// Builds dist/scoutbox-connected-demo.html — the three ACTUAL demo interfaces
// under one shared synthetic state ("Shared simulation — no live backend").
//
// Architecture: the Player demo is the host document (expo-router needs a real
// top-level URL; the portals are screen-state SPAs and embed safely as srcdoc
// iframes). The demo bus normally rides BroadcastChannel + localStorage —
// neither crosses the artifact sandbox's per-frame opaque origins — so every
// document gets a BroadcastChannel replacement that relays over postMessage:
// the host is the hub, the portal frames are spokes. Presence heartbeats ride
// the same bus, so each app's simulated counterparty stands down exactly as it
// does across real same-origin tabs.
//
// Run AFTER buildDemos.mjs:  node buildConnectedDemo.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const ROOT = path.join(HERE, '..');
const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
const built = new Date().toISOString().slice(0, 10);

const read = (f) => fs.readFileSync(path.join(DIST, f), 'utf8');
let player = read('scoutbox-player-demo.html');
let pro = read('scoutbox-club-demo.html');
let grass = read('scoutbox-grassroots-demo.html');

// ---- spoke shim: portals post bus traffic to the host, receive relays back
const CHILD_SHIM = `<script data-bus-spoke>(function(){
  var chans=[];
  function BC(name){this.name=name;this.onmessage=null;chans.push(this);}
  BC.prototype.postMessage=function(data){var n=this.name;try{parent.postMessage({__sbBus:{name:n,data:data}},'*');}catch(e){}};
  BC.prototype.close=function(){var i=chans.indexOf(this);if(i>=0)chans.splice(i,1);};
  window.addEventListener('message',function(ev){var m=ev.data&&ev.data.__sbBus;if(!m)return;
    for(var i=0;i<chans.length;i++){var c=chans[i];if(c.name===m.name&&typeof c.onmessage==='function'){try{c.onmessage({data:m.data});}catch(e){}}}});
  window.BroadcastChannel=BC;
})();</scr` + `ipt>`;

// ---- hub shim: the host's own bus channels + fan-out to every portal frame
const HUB_SHIM = `<script data-bus-hub>(function(){
  var chans=[];
  function frames(){return Array.prototype.slice.call(document.querySelectorAll('iframe[data-sb-app]'));}
  function deliver(name,data,except){for(var i=0;i<chans.length;i++){var c=chans[i];if(c===except)continue;
    if(c.name===name&&typeof c.onmessage==='function'){try{c.onmessage({data:data});}catch(e){}}}}
  function fanout(name,data,sourceWin){frames().forEach(function(f){try{
    if(f.contentWindow&&f.contentWindow!==sourceWin)f.contentWindow.postMessage({__sbBus:{name:name,data:data}},'*');}catch(e){}});}
  function BC(name){this.name=name;this.onmessage=null;chans.push(this);}
  BC.prototype.postMessage=function(data){var self=this;setTimeout(function(){deliver(self.name,data,self);fanout(self.name,data,null);},0);};
  BC.prototype.close=function(){var i=chans.indexOf(this);if(i>=0)chans.splice(i,1);};
  window.addEventListener('message',function(ev){var m=ev.data&&ev.data.__sbBus;if(!m)return;
    deliver(m.name,m.data,null);fanout(m.name,m.data,ev.source);});
  window.BroadcastChannel=BC;
})();</scr` + `ipt>`;

// portals get the spoke shim as the very first thing in <head>
pro = pro.replace(/<head>/i, () => `<head>${CHILD_SHIM}`);
grass = grass.replace(/<head>/i, () => `<head>${CHILD_SHIM}`);
const embed = (html) => JSON.stringify(html).replace(/</g, '\\u003c');

// host: hub shim first in <head>, before the app bundle boots its bus
player = player.replace(/<head>/i, () => `<head>${HUB_SHIM}`);
player = player.replace(/<title>[^<]*<\/title>/i, () => '<title>ScoutBox — Connected Demo</title>');

const SHELL = `
<style data-sb-shell-css>
  #root { height: calc(100% - 44px) !important; margin-top: 44px; }
  #sb-bar { position: fixed; top: 0; left: 0; right: 0; height: 44px; z-index: 2147483200;
    display: flex; align-items: center; gap: 6px; padding: 0 10px; box-sizing: border-box;
    background: #101a2e; border-bottom: 1px solid #263a5e; font: 12.5px system-ui, sans-serif; color: #8fa3c8; }
  #sb-bar button { font: inherit; cursor: pointer; border: 1px solid #263a5e; background: #16233c;
    color: #e8eefc; border-radius: 8px; padding: 5px 12px; }
  #sb-bar button.on { background: #35d07f; border-color: #35d07f; color: #04240f; font-weight: 700; }
  #sb-bar .sb-note { margin-left: auto; text-align: right; line-height: 1.2; font-size: 10.5px; white-space: nowrap; overflow: hidden; }
  iframe[data-sb-app] { position: fixed; top: 44px; left: 0; width: 100%; height: calc(100% - 44px);
    border: 0; background: #0b1220; z-index: 2147483100; }
  #sb-guide { position: fixed; top: 52px; left: 8px; z-index: 2147483300; max-width: 340px;
    background: #16233c; border: 1px solid #263a5e; border-radius: 12px; padding: 14px 16px;
    color: #e8eefc; font: 12.5px/1.55 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #sb-guide ol { margin: 6px 0 0; padding-left: 18px; }
  #sb-guide .dim { color: #8fa3c8; }
</style>
<div id="sb-bar">
  <button id="sb-b-player" class="on">⚽ Player</button>
  <button id="sb-b-pro">🔭 Pro</button>
  <button id="sb-b-grassroots">🌱 Grassroots</button>
  <button id="sb-b-guide" title="How to run the demo">?</button>
  <span class="sb-note"><b>Shared simulation — no live backend.</b><br>One synthetic dataset · build ${sha} · ${built}</span>
</div>
<div id="sb-guide" hidden>
  <b>Demo script</b> <span class="dim">(everything below flows through one shared in-page simulation — nothing reaches real people)</span>
  <ol>
    <li><b>Pro</b> → Eastport FC → Search → Kola Adeyemi → Request contact.</li>
    <li><b>Player</b> → Enter as Kola → Inbox → Accept contact → reply in the thread.</li>
    <li><b>Pro</b> → Messages: the reply + red unread badge.</li>
    <li><b>Grassroots</b> → Moss Side Athletic → same flow with Kola.</li>
    <li><b>Pro</b> → Guni Adebayo (14) → Contact Guardian. <b>Player</b> → You → Log out → Enter as Amara (guardian, last row) → accept + reply.</li>
    <li>Log out → Enter as Guni: the child sees only sanitised status — never the conversation.</li>
    <li><b>Pro</b> → Search → Kola Adeyemi → <b>Add to Recruitment Room</b>: the club's own private decision layer opens on the player.</li>
    <li>In the Room: <b>Overview</b> (Trust Score with "evidence confidence — not football ability", decision readiness as counts) → <b>Passport</b> → <b>Combine</b> → <b>Discussion</b> (internal only) → change status to <b>Shortlisted</b> (the evidence confidence at that moment is captured).</li>
    <li><b>Decision</b> → record a recommendation with a <i>structured</i> reason. Try archiving with no reason — it is refused. There is no protected characteristic to pick.</li>
    <li><b>Player</b> → Enter as Kola → You: no Room, no status, no discussion, no decision. The club's thinking never crosses the line.</li>
  </ol>
  <div class="dim" style="margin-top:6px">State lives in this page only and resets on reload.</div>
</div>
<script type="application/json" id="sb-src-pro">${embed(pro)}</script>
<script type="application/json" id="sb-src-grassroots">${embed(grass)}</script>
<script data-sb-shell>(function(){
  var apps = ['player','pro','grassroots'];
  var frames = {};
  ['pro','grassroots'].forEach(function(name){
    var f = document.createElement('iframe');
    f.setAttribute('data-sb-app', name);
    f.hidden = true;
    f.srcdoc = JSON.parse(document.getElementById('sb-src-' + name).textContent);
    document.body.appendChild(f);
    frames[name] = f;
  });
  function show(name){
    apps.forEach(function(a){
      var b = document.getElementById('sb-b-' + a);
      if (b) b.className = a === name ? 'on' : '';
      if (frames[a]) frames[a].hidden = a !== name;
    });
  }
  apps.forEach(function(a){
    document.getElementById('sb-b-' + a).addEventListener('click', function(){ show(a); });
  });
  var guide = document.getElementById('sb-guide');
  document.getElementById('sb-b-guide').addEventListener('click', function(){ guide.hidden = !guide.hidden; });
})();</scr` + `ipt>`;

player = player.replace(/<\/body>/i, () => `${SHELL}</body>`);
const out = path.join(DIST, 'scoutbox-connected-demo.html');
fs.writeFileSync(out, player);
console.log(`${out} ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)}MB (build ${sha})`);
