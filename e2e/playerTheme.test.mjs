import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../design-system/player-theme/theme.js', import.meta.url), 'utf8');
function boot(saved, dark, blocked = false) {
  let value = saved;
  const root = {dataset:{},style:{},classList:{toggle(){}}};
  const listeners = {};
  const media = {matches:dark,addEventListener(_,fn){listeners.media=fn;}};
  const window = {matchMedia:()=>media,addEventListener(name,fn){listeners[name]=fn;}};
  const storage={getItem(){if(blocked)throw Error();return value;},setItem(_,v){if(blocked)throw Error();value=v;},removeItem(){value=null;}};
  vm.runInNewContext(script,{window,document:{documentElement:root},localStorage:storage});
  return {root,window,media,listeners,stored:()=>value};
}
const t=boot('light',true);
assert.equal(t.root.dataset.theme,'light');
t.window.ScoutBoxTheme.set('dark'); assert.equal(t.root.dataset.theme,'dark'); assert.equal(t.stored(),'dark');
t.window.ScoutBoxTheme.set('system'); assert.equal(t.stored(),null);
t.media.matches=false;t.listeners.media();assert.equal(t.root.dataset.theme,'light');
t.listeners.storage({key:'sb-theme:player',newValue:'dark'});assert.equal(t.root.dataset.theme,'dark');
t.listeners.storage({key:null,newValue:null});assert.equal(t.root.dataset.theme,'light');
assert.throws(()=>t.window.ScoutBoxTheme.set('invalid'));
const blocked=boot(null,true,true);blocked.window.ScoutBoxTheme.set('light');assert.equal(blocked.root.dataset.theme,'light');
const rgb=h=>h.match(/\w\w/g).map(v=>parseInt(v,16)/255);
const lum=c=>c.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
for(const [end,ink,shade] of [['0088ff','081419',0],['12161a','ffffff',.55]]){
 for(let i=0;i<=100;i++){
  const bg=rgb('00e676').map((v,j)=>(v+(rgb(end)[j]-v)*i/100)*(1-shade));
  const a=lum(bg),b=lum(rgb(ink));
  assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`gradient contrast at ${i}%`);
 }
}
console.log('Theme checks passed: saved/system preferences, live changes, blocked storage, invalid input, gradient text contrast.');
