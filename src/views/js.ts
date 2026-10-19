/** Minimal client JS (served at /static/app.js; CSP allows only 'self'): scan progress polling + copy buttons. */
export const JS = `
(function(){
  var el=document.querySelector('[data-poll]');
  if(el){
    var url=el.getAttribute('data-poll'),bar=el.querySelector('progress'),label=el.querySelector('[data-phase]');
    var tick=function(){fetch(url,{headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(s){
      if(bar)bar.value=s.progress||0;if(label)label.textContent=s.phaseLabel||'';
      if(s.status==='done'||s.status==='failed'){location.reload();return}setTimeout(tick,2000)}).catch(function(){setTimeout(tick,4000)})};
    setTimeout(tick,1500);
  }
  document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
    var t=document.getElementById(b.getAttribute('data-copy'));if(!t)return;
    navigator.clipboard.writeText(t.textContent||'').then(function(){b.textContent='Copied'})})});
  document.querySelectorAll('[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.getAttribute('data-confirm')))e.preventDefault()})});
  document.querySelectorAll('time[datetime]').forEach(function(t){try{var d=new Date(t.getAttribute('datetime'));t.title=t.textContent;t.textContent=d.toLocaleString()}catch(e){}});
})();
`;
