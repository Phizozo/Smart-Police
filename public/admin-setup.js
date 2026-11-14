'use strict';
(() => {
  const app = document.getElementById('app');
  let setupRoute = false;
  let token = '';
  let active = false, sessionPresent = false, requestApi = null, csrfRefresh = null, info = null;
  const roleName = role => role === 'officer' ? 'Officer' : 'Admin';
  function captureRoute(){
    if(location.hash==='#admin-setup'&&setupRoute)return true;
    const match=location.hash.match(/^#admin-setup(?:\/([^/?#]+))?$/);
    if(!match)return false;
    document.body.classList.remove('home-glass');
    setupRoute=true;token=match[1]||'';
    if(location.hash!=='#admin-setup')history.replaceState(null,'',`${location.pathname}${location.search}#admin-setup`);
    return true;
  }
  captureRoute();
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const page = document.getElementById('app');
  function clear() { active=false; setupRoute=false; token=''; info=null; requestApi=null; csrfRefresh=null; if(page && page.querySelector('.admin-setup-page'))page.innerHTML=''; }
  function isMarker(){return location.hash==='#admin-setup';}
  function showError(message) {
    document.body.classList.remove('home-glass');
    token='';
    document.body.classList.add('workspace-theme');
    page.innerHTML=`<main class="admin-setup-page" aria-labelledby="admin-setup-title"><span class="eyebrow">STAFF ACCOUNT SETUP</span><h1 id="admin-setup-title">This setup link is unavailable</h1><p class="setup-error" role="alert">${esc(message)}</p><p>This private link may be missing, expired, or already used. Ask an active Admin to issue a new one.</p><a href="#portal">Go to access portal</a></main>`;
  }
  function bootstrapError(message){active=true;token='';showError(message);}
  function renderSetup(error='') {
    document.body.classList.remove('home-glass');
    document.body.classList.add('workspace-theme');
    const account=info||{};
    const role=account.role||'admin', title=roleName(role);
    page.innerHTML=`<main class="admin-setup-page" aria-labelledby="admin-setup-title"><span class="eyebrow">${title.toUpperCase()} ACCOUNT SETUP</span><h1 id="admin-setup-title">${error?'Set a new password':'Welcome, '+esc(account.name||title)}</h1>${error?`<p class="setup-error" role="alert">${esc(error)}</p>`:`<p>Your ${title} username is <strong>${esc(account.username)}</strong>. This link expires ${account.expires_at?`at ${esc(new Date(Number(account.expires_at)*1000).toLocaleString())}`:'within one hour'} and can be used once.</p><form id="admin-setup-complete" novalidate><label for="admin-setup-password">Choose a password</label><div class="password-field"><input id="admin-setup-password" name="password" type="password" autocomplete="new-password" maxlength="16" required aria-describedby="admin-setup-password-help"><button type="button" class="password-toggle" data-setup-toggle="admin-setup-password" aria-label="Show password" aria-pressed="false">Show</button></div><small id="admin-setup-password-help" class="field-help">Use 5–8 Unicode characters.</small><label for="admin-setup-confirm">Confirm password</label><input id="admin-setup-confirm" name="confirm" type="password" autocomplete="new-password" maxlength="16" required><p class="form-error" role="alert" aria-live="polite"></p><button type="submit">Set ${title} password</button></form>`}<div class="setup-login-action"><p>${sessionPresent?'A different account is currently signed in. Sign out before switching portals.':'Password setup does not sign you in automatically.'}</p><button type="button" data-setup-login data-setup-role="${esc(role)}">${sessionPresent?'Sign out and continue':'Go to '+title+' login'}</button></div></main>`;
  }
  async function start(api, hasSession, refresh) {
    active=true; requestApi=api; sessionPresent=!!hasSession; csrfRefresh=refresh;
    if (!token) { showError('The setup link does not contain a valid token.'); return; }
    try {
      const result=await api('admin_setup_info',{token});
      if(!result?.ok)throw new Error('This setup link is invalid, expired, or already used.');
      info=result; renderSetup();
    } catch (error) { showError(error?.error||error?.message||'This setup link is invalid, expired, or already used.'); }
  }
  page.addEventListener('submit',async event=>{
    if(event.target.id!=='admin-setup-complete')return;
    event.preventDefault();event.stopImmediatePropagation();
    const form=event.target, message=form.querySelector('.form-error'),button=form.querySelector('[type="submit"]'),values=Object.fromEntries(new FormData(form)),length=Array.from(values.password||'').length;
    if(length<5||length>8){message.textContent='Password must be 5–8 Unicode characters.';return;}
    if(values.password!==values.confirm){message.textContent='Passwords do not match.';return;}
    button.disabled=true;message.textContent='';
    try {
      const result=await requestApi('admin_setup_complete',{token,password:values.password,confirm:values.confirm});
      if(!result?.ok)throw new Error('Could not complete Admin setup.');
      token='';info=null;
       const title=roleName(result.role), role=result.role==='officer'?'officer':'admin';
       page.innerHTML=`<main class="admin-setup-page" aria-labelledby="admin-setup-title"><span class="eyebrow">${title.toUpperCase()} ACCOUNT SETUP</span><h1 id="admin-setup-title">Password set</h1><p class="setup-success" role="status">Your ${title} account is ready. ${sessionPresent?'Your existing account session has not changed.':'You are not signed in.'}</p><p>Username: <strong>${esc(result.username||'')}</strong></p><button type="button" data-setup-login data-setup-role="${role}">${sessionPresent?'Sign out and continue':'Go to '+title+' login'}</button></main>`;
    } catch(error){message.textContent=error?.error||error?.message||'Could not complete setup. Request a fresh link if this one has expired.';button.disabled=false;}
  },true);
  page.addEventListener('click',async event=>{
    const toggle=event.target.closest('[data-setup-toggle]');
    if(toggle){const input=document.getElementById(toggle.dataset.setupToggle);if(input){input.type=input.type==='password'?'text':'password';toggle.textContent=input.type==='password'?'Show':'Hide';toggle.setAttribute('aria-pressed',String(input.type==='text'));}return;}
    const login=event.target.closest('[data-setup-login]');
    if(!login)return;
    login.disabled=true;
    if(sessionPresent){
      try{await requestApi('logout',{});sessionPresent=false;await csrfRefresh();}catch(error){login.disabled=false;login.textContent='Sign out failed — try again';return;}
    }
    const role=login.dataset.setupRole==='officer'?'officer':'admin';
    clear();location.hash=`#portal/${role}/login`;
  });
  window.addEventListener('hashchange',()=>{
    if(captureRoute())return;
    if(!active)return;
    if(isMarker())return;
    clear();
  });
  window.AdminSetup={isRoute:()=>setupRoute, isActive:()=>active, isMarker, start, clear, bootstrapError};
})();
