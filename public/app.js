'use strict';
const $ = s => document.querySelector(s), app = $('#app');
let S = null, csrf = '', csrfBootstrapped = false, tab = '', seen = '', sosWatch = null, openSos = -1, portalRole = 'citizen', portalMode = 'login', firstRun = false, backupBusy = false, connectionError = '', reportFrom = '', reportTo = '', reportDownloads = 0, pendingTwoStepUsername = '';
const activeAlerts = new Set();
const incidentTypes = ['Theft', 'Assault', 'Fraud', 'Vandalism', 'Traffic accident', 'Suspicious activity', 'Other'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = t => new Date(t * 1000).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function toast(m) { const t = $('#toast'); t.textContent = m; t.className = 'on'; setTimeout(() => t.className = '', 3200); }
function usernameError(value) {
  const username=String(value??'').trim(), length=Array.from(username).length;
  if(!username)return 'Enter a username.';
  if(length>80)return 'Usernames can be up to 80 characters.';
  if(/\p{Cc}/u.test(username))return 'Remove control characters from the username.';
  return '';
}
function passwordError(value, creating = false) {
  const n = Array.from(value || '').length;
  if (n < 5 || n > 8) return 'Password must be 5–8 characters.';
  if (creating && /^0+$/.test(value)) return 'Weak Password. Choose a password that is not all zeroes.';
  return '';
}
function adminEmailError(value) { return /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@admin\.co\.za$/i.test(String(value || '').trim()) ? '' : 'Use an email ending @admin.co.za.'; }
function citizenEmailError(value) { return /^[^\s@]+@gmail\.com$/i.test(String(value || '').trim()) ? '' : 'Use a valid email ending @gmail.com.'; }
function citizenPhoneError(value) { return /^[1-9][0-9]{8}$/.test(String(value || '').trim()) ? '' : 'Enter the 9 digits after +27.'; }
function citizenAddressError(value) { const address=String(value || '').trim(); return Array.from(address).length>=5&&!/\p{Cc}/u.test(address) ? '' : 'Enter your residential address.'; }
function setAuthFieldError(input, message) {
  if (!input) return;
  const error = document.getElementById(input.dataset.errorTarget || '');
  if (error) { error.textContent = message; error.hidden = !message; }
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}
function hasHeldInterface() {
  return !!app.querySelector('dialog[open], details[open]') ||
    [...app.querySelectorAll('form[data-f], form#lf, form#two-step-form, form#phone-otp-send, form#phone-otp-verify')].some(f => f.dataset.dirty === 'true' || f.dataset.submitting === 'true') ||
    (app.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
}
async function api(a, body, form) {
  const o = {method: body ? 'POST' : 'GET', headers: {'X-CSRF': csrf}};
  if (body) { if (form) o.body = body; else { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; } }
  const r = await fetch('api.php?a=' + a, o), j = await r.json().catch(() => ({error: 'Unexpected response'}));
  if (j.csrf) csrf = j.csrf;
  if (r.status === 401 || j.code === 'SESSION_DISPLACED') {
    clearAdminInvite();
    if(window.AdminSetup?.isActive())window.AdminSetup.clear();
    if(S){S = null; login(j.error || 'Your session ended. Please sign in again.');}
    throw j;
  }
  if (!r.ok) throw j; return j;
}
const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await load(true); } catch (e) { if (e.error) toast(e.error); } };
const webauthnBase64 = {
  encode(buffer) { const bytes = new Uint8Array(buffer); let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  decode(value) { const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4); const raw = atob(base64); return Uint8Array.from(raw, character => character.charCodeAt(0)); }
};
function webauthnCreateOptions(options) {
  return {...options, challenge: webauthnBase64.decode(options.challenge), user: {...options.user, id: webauthnBase64.decode(options.user.id)}, excludeCredentials: (options.excludeCredentials || []).map(item => ({...item, id: webauthnBase64.decode(item.id)}))};
}
function webauthnGetOptions(options) {
  return {...options, challenge: webauthnBase64.decode(options.challenge), allowCredentials: (options.allowCredentials || []).map(item => ({...item, id: webauthnBase64.decode(item.id)}))};
}
function webauthnRegistrationJson(credential) {
  return {id:credential.id,rawId:webauthnBase64.encode(credential.rawId),type:credential.type,response:{clientDataJSON:webauthnBase64.encode(credential.response.clientDataJSON),attestationObject:webauthnBase64.encode(credential.response.attestationObject),transports:credential.response.getTransports?credential.response.getTransports():[]},clientExtensionResults:credential.getClientExtensionResults()};
}
function webauthnAssertionJson(credential) {
  return {id:credential.id,rawId:webauthnBase64.encode(credential.rawId),type:credential.type,response:{clientDataJSON:webauthnBase64.encode(credential.response.clientDataJSON),authenticatorData:webauthnBase64.encode(credential.response.authenticatorData),signature:webauthnBase64.encode(credential.response.signature),userHandle:credential.response.userHandle?webauthnBase64.encode(credential.response.userHandle):null},clientExtensionResults:credential.getClientExtensionResults()};
}
async function passkeyLogin(button, requestedUsername = '') {
  const form = $('#lf'), username = requestedUsername || $('#u')?.value.trim() || '', message = form?.querySelector('.err');
  const isSecondStep = !!pendingTwoStepUsername && username === pendingTwoStepUsername;
  if (message) message.textContent = '';
  if (!username) { if (message) message.textContent = 'Enter your Citizen username first.'; $('#u')?.focus(); return; }
  if (!window.isSecureContext || !navigator.credentials?.get) { if (message) message.textContent = 'Passkeys need a supported browser and a secure HTTPS connection. Use password sign-in instead.'; return; }
  button.disabled = true; button.textContent = 'Checking device…';
  try {
    const {options} = await api('passkey_login_options', {username});
    const credential = await navigator.credentials.get({publicKey:webauthnGetOptions(options)});
    const result = await api('passkey_login_verify', webauthnAssertionJson(credential));
    if (result.csrf) csrf = result.csrf;
    pendingTwoStepUsername = '';
    location.hash = '#app';
    await load(true);
  } catch (error) {
    if (message) message.textContent = error?.name === 'NotAllowedError' ? (isSecondStep ? 'Device verification was cancelled. Select Verify device passkey to try again.' : 'Passkey sign-in was cancelled. Try again or use your password.') : (error.error || 'Passkey sign-in failed. Use your password or try again.');
  } finally {
    if (app.contains(button)) { button.disabled = false; button.textContent = isSecondStep ? 'Verify device passkey' : 'Sign in with device passkey'; }
  }
}
async function completeCitizenSignupPasskey(password) {
  try {
    const {options} = await api('passkey_register_options', {password});
    const credential = await navigator.credentials.create({publicKey:webauthnCreateOptions(options)});
    if (!credential) throw new Error('The device did not save the passkey.');
    await api('passkey_register_verify', webauthnRegistrationJson(credential));
    portalMode = 'login';
    pendingTwoStepUsername = '';
    history.replaceState(null, '', '#app');
    location.hash = '#app';
    toast('Account created and passkey saved.');
    await load(true);
  } catch {
    await api('logout', {}).catch(() => {});
    history.replaceState(null, '', '#portal/citizen/login');
    login();
    const message = $('#lf .err');
    if (message) message.textContent = 'Your account was created, but passkey setup was not completed. Sign in with your password and enable Two-step verification later under Account security.';
  }
}
async function refreshCsrf() {
  const response = await fetch('api.php?a=csrf', {credentials: 'same-origin', cache: 'no-store'});
  const result = await response.json();
  csrf = result.csrf || '';
  if (!result.me) { S = null; seen = ''; clearAdminInvite(); }
}
function togglePassword(button) {
  const input = document.getElementById(button.dataset.passwordTarget);
  if (!input) return;
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.textContent = visible ? 'Hide' : 'Show';
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  button.setAttribute('aria-pressed', String(visible));
}

function login(msg = '', reg = false) {
  document.body.classList.remove('home-glass');
  document.body.classList.add('workspace-theme');
  tab = 'dashboard';
  if (msg) toast(msg);
  portalMode = reg ? 'signup' : 'login';
  window.CitizenServices?.syncDashboard(false);
  if(sosWatch!==null){navigator.geolocation?.clearWatch(sosWatch);sosWatch=null;}
  activeAlerts.clear();
  S = null; seen = '';
  if(firstRun)portalRole='admin';
  const creating = firstRun && portalRole === 'admin' || reg;
    app.innerHTML = `<div class="site-shell"><header class="public-nav"><a class="brand" href="#home"><span class="brand-mark">SP</span><span>SMART<span class="brand-light">POLICE</span><small>COMMUNITY SAFETY PLATFORM</small></span></a><a href="#home">Home</a><a href="#portal" class="nav-current">Access portal</a><a class="nav-access" href="#portal">Secure access ↗</a></header><main class="public-main"><a href="#home" class="back-link">← Back to home</a><section class="portal-intro"><span class="eyebrow">SECURE ACCESS</span><h1>Choose your portal.</h1><p>Sign in to the workspace for your role. Citizens can create an account here.</p></section><section class="portal-grid" aria-label="Choose account role">${[['citizen','01','Citizen portal','Report incidents, submit evidence and follow your case.'],['officer','02','Officer portal','Respond to cases, review reports and certify affidavits.'],['admin','03','Admin portal','Manage accounts and review confidential records.']].map(([role,no,title,desc])=>`<button type="button" class="portal-card ${portalRole===role?'portal-selected':''}" data-role="${role}" aria-pressed="${portalRole===role}"><span class="portal-number">${no}</span><span class="portal-copy"><strong>${title}</strong><small>${desc}</small></span><span class="portal-arrow" aria-hidden="true">↗</span></button>`).join('')}</section><form id="lf" class="auth-card" novalidate><div class="auth-card-heading"><span class="eyebrow">${firstRun&&portalRole==='admin'?'INITIAL SETUP':portalRole.toUpperCase()+' ACCESS'}</span><h2>${firstRun&&portalRole==='admin'?'Create the administrator account':reg&&portalRole==='citizen'?'Create your citizen account':'Sign in to continue'}</h2><p>${firstRun&&portalRole==='admin'?'Create the first administrator to configure the officer portal.':'Your account access is limited to your assigned role.'}</p></div>${creating?'<label for="n">Full name</label><input id="n" name="name" required autocomplete="name" placeholder="Your full name">':''}${creating&&portalRole==='admin'?'<label for="admin-email">Admin email</label><input id="admin-email" name="email" type="email" required maxlength="254" autocomplete="email" aria-describedby="admin-email-help admin-email-error" data-error-target="admin-email-error" placeholder="name@admin.co.za"><small id="admin-email-help" class="field-help">Use an email ending @admin.co.za.</small><small id="admin-email-error" class="field-error" role="alert" hidden></small>':''}<label for="u">Username</label><input id="u" name="username" required minlength="3" maxlength="30" autocomplete="username" placeholder="Your username" aria-describedby="username-help username-error" data-error-target="username-error"><small id="username-help" class="field-help">3–30 lowercase letters, numbers, dots, or underscores.</small><small id="username-error" class="field-error" role="alert" hidden></small><label for="p">Password</label><div class="password-field"><input id="p" name="password" type="password" required autocomplete="${creating?'new-password':'current-password'}" maxlength="16" aria-describedby="password-help password-error" data-error-target="password-error" placeholder="${creating?'Create a password':'Your password'}"><button type="button" class="password-toggle" data-password-target="p" aria-label="Show password" aria-pressed="false">Show</button></div><small id="password-help" class="field-help">Every account password is 5–8 Unicode characters. Older passwords longer than 8 characters need an administrator reset.</small><small id="password-error" class="field-error" role="alert" hidden></small>${creating?'<label for="pc">Confirm password</label><input id="pc" name="confirm" type="password" required autocomplete="new-password" maxlength="16" aria-describedby="confirm-password-error" data-error-target="confirm-password-error" placeholder="Enter the password again"><small id="confirm-password-error" class="field-error" role="alert" hidden></small>':''}<p class="err" role="alert" aria-live="polite"></p><button class="auth-submit" type="submit">${firstRun&&portalRole==='admin'?'Create administrator account':reg&&portalRole==='citizen'?'Create account':'Secure sign in'} <span aria-hidden="true">→</span></button>${!firstRun&&portalRole==='citizen'&&!reg?'<button type="button" class="auth-switch" id="passkey-login">Sign in with device passkey</button><button type="button" class="auth-switch" id="two-step-verify" hidden>Verify device passkey</button>':''}${!firstRun&&portalRole==='citizen'?`<button type="button" class="auth-switch" id="sw">${reg?'Already registered? Sign in':'New to Smart Police? Create an account'}</button>`:''}</form></main><footer class="public-footer"><span>SMART POLICE</span></footer></div>`;
  const usernameInput=$('#u'),usernameHelp=$('#username-help'),passwordHelp=$('#password-help');
  window.CitizenLoginCamera?.attach($('#passkey-login'));
  if(usernameInput){usernameInput.removeAttribute('minlength');usernameInput.maxLength=160;usernameInput.setAttribute('aria-describedby','username-error');}
  usernameHelp?.remove();
  if(passwordHelp)passwordHelp.textContent='Use 5–8 characters.';
  const roleTitle = {citizen:'Citizen',officer:'Officer',admin:'Admin'}[portalRole];
  const heading = $('#lf .auth-card-heading h2');
  if (reg && heading) heading.textContent = `Create your ${roleTitle.toLowerCase()} account`;
  if (reg) { const submit=$('#lf .auth-submit'); if(submit)submit.innerHTML='Create account <span aria-hidden="true">→</span>'; }
  const intro = $('.portal-intro');
  if (intro && !firstRun) { intro.querySelector('h1').textContent = `${roleTitle} portal`; intro.querySelector('p').textContent = `A dedicated workspace for ${roleTitle.toLowerCase()} accounts.`; }
  if (creating) {
     ['#p','#pc'].forEach(selector=>{const input=$(selector);if(input){input.removeAttribute('minlength');input.setAttribute('maxlength','16');}});
  }
  if (!firstRun) {
    const modes = document.createElement('nav');
    modes.className = 'portal-auth-modes';
    modes.setAttribute('aria-label', `${roleTitle} account options`);
    modes.innerHTML = `<a class="${reg?'':'selected'}" ${reg?'':'aria-current="page"'} href="#portal/${portalRole}/login">Sign in</a><a class="${reg?'selected':''}" ${reg?'aria-current="page"':''} href="#portal/${portalRole}/signup">Sign up</a>`;
    $('#lf').before(modes);
   if (reg) {
      const h = $('#lf .auth-card-heading h2'); if (h) h.textContent = `Create your ${roleTitle.toLowerCase()} account`;
       const p = $('#lf .auth-card-heading p'); if (p) p.textContent = portalRole === 'citizen' ? 'Your Citizen account is ready right after signup. You can enable Two-step verification later under Account security.' : 'An administrator must approve new staff accounts before sign-in.';
    }
  } else {
    const introText = $('.portal-intro p');
    if (introText) introText.textContent = 'Create the first administrator account. Officer and citizen signup are unavailable until the first administrator exists.';
    document.querySelectorAll('[data-role]').forEach(b=>{if(b.dataset.role!=='admin'){b.disabled=true;b.setAttribute('aria-disabled','true');}});
  }
  document.querySelectorAll('[data-role]').forEach(b=>b.onclick=()=>{portalRole=b.dataset.role;location.hash=`#portal/${portalRole}/${reg?'signup':'login'}`;});
  $('#sw')?.addEventListener('click',()=>{location.hash=`#portal/${portalRole}/${reg?'login':'signup'}`;});
  if(reg&&portalRole==='citizen'){
    const fields=document.createElement('div');
    fields.className='citizen-signup-fields';
    fields.innerHTML='<label for="citizen-address">Residential address</label><input id="citizen-address" name="residential_address" type="text" required maxlength="240" autocomplete="street-address" placeholder="Street address, suburb and city" aria-describedby="citizen-address-error" data-error-target="citizen-address-error"><small id="citizen-address-error" class="field-error" role="alert" hidden></small><label for="citizen-phone">Phone number (+27)</label><div class="international-phone"><span aria-hidden="true">+27</span><input id="citizen-phone" name="phone" type="tel" required inputmode="numeric" autocomplete="tel-national" maxlength="9" pattern="[1-9][0-9]{8}" placeholder="821234567" aria-describedby="citizen-phone-error" data-error-target="citizen-phone-error"></div><small id="citizen-phone-error" class="field-error" role="alert" hidden></small><label for="citizen-email">Email (@gmail.com)</label><input id="citizen-email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@gmail.com" aria-describedby="citizen-email-error" data-error-target="citizen-email-error"><small id="citizen-email-error" class="field-error" role="alert" hidden></small>';
    $('#lf label[for="u"]')?.before(fields);
     const camera=document.createElement('div');
     camera.className='citizen-signup-camera';
     camera.innerHTML=window.FaceCamera.markup()+'<label class="service-consent"><input type="checkbox" name="face_consent" value="yes" required> I agree to store this camera photo securely for human review by Admins and assigned Officers.</label><p class="field-help">The photo is encrypted in the app. Only Admins and Officers who can access a related service request may view it. It does not perform automated face recognition or face-to-ID matching.</p>';
     $('#lf .auth-submit')?.before(camera);
  }
  const authForm=$('#lf');
  if(!firstRun){
    const links=document.createElement('div');
    links.className='auth-secondary-links';
    const signUpSwitch=$('#sw');
    if(signUpSwitch)links.append(signUpSwitch);
    const forgot=document.createElement('a');
    forgot.href='#forgot-password';forgot.id='forgot-password-link';forgot.className='auth-forgot';forgot.textContent='Forgot password?';forgot.setAttribute('aria-expanded','false');
    const help=document.createElement('p');
    help.id='forgot-password-help';help.className='forgot-password-help';help.hidden=true;
    help.textContent='Ask an administrator to reset your password from Manage users, then sign in with the new password. Admins should ask another active Admin. Never share your current password.';
    forgot.addEventListener('click',event=>{event.preventDefault();help.hidden=!help.hidden;forgot.setAttribute('aria-expanded',String(!help.hidden));});
    links.append(forgot,help);
    authForm.append(links);
  }
  authForm.addEventListener('input',e=>{
    if ((e.target.id === 'u' || e.target.id === 'p') && pendingTwoStepUsername) {
      pendingTwoStepUsername = '';
      const retry = $('#two-step-verify');
      if (retry) retry.hidden = true;
    }
    if(e.target.dataset.errorTarget)setAuthFieldError(e.target,'');
    const confirm=$('#pc'), password=$('#p');
    if(confirm&&password&&(e.target===confirm||e.target===password)&&confirm.value)setAuthFieldError(confirm,confirm.value===password.value?'':'Passwords do not match.');
    authForm.querySelector('.err').textContent='';
  });
  authForm.onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;if(form.dataset.submitting==='true')return;const button=form.querySelector('[type="submit"]'),d=Object.fromEntries(new FormData(form)),setup=firstRun&&portalRole==='admin',creating=setup||reg,err=form.querySelector('.err');err.textContent='';
    const invalid=[];
    if(creating){const message=usernameError(d.username);if(message)invalid.push([$('#u'),message]);}
    if(creating&&portalRole==='admin'){const message=adminEmailError(d.email);if(message)invalid.push([$('#admin-email'),message]);}
    if(creating&&portalRole==='citizen'){
      const emailMessage=citizenEmailError(d.email),phoneMessage=citizenPhoneError(d.phone),addressMessage=citizenAddressError(d.residential_address);
      if(emailMessage)invalid.push([$('#citizen-email'),emailMessage]);
      if(phoneMessage)invalid.push([$('#citizen-phone'),phoneMessage]);
      if(addressMessage)invalid.push([$('#citizen-address'),addressMessage]);
    }
    const perr=passwordError(d.password,creating);if(perr)invalid.push([$('#p'),perr]);
    if(creating&&d.password!==d.confirm)invalid.push([$('#pc'),'Passwords do not match.']);
    if(invalid.length){invalid.forEach(([input,message])=>setAuthFieldError(input,message));invalid[0][0]?.focus();return;}
    if(!creating&&portalRole==='citizen'&&!form.querySelector('[name=login_capture]')?.files?.length){
      err.textContent='Open Face Recognition and press Capture before signing in.';
      $('#login-camera-open')?.focus();return;
    }
    form.dataset.submitting='true';button.disabled=true;button.textContent='Please wait…';
    try{
      delete d.confirm;
       if(creating&&(portalRole==='admin'||portalRole==='citizen'))d.email=String(d.email||'').trim().toLowerCase();else delete d.email;
      if(setup){csrf=(await api('setup',d)).csrf;firstRun=false;location.hash='app';return await load(true);}
       if(reg){
          const wantsPasskey=false;
         if(wantsPasskey&&(!window.isSecureContext||!navigator.credentials?.create)){err.textContent='Passkey setup needs a supported browser and a secure connection. Uncheck “Create a passkey now” to continue; you can enable Two-step verification later under Account security.';form.dataset.submitting='false';button.disabled=false;button.textContent='Create account';return;}
          let signupPassword=wantsPasskey?d.password:'';
          const signupPayload=new FormData(form);
          signupPayload.delete('confirm');
          signupPayload.set('role',portalRole);
          signupPayload.delete('passkey_enroll');
          const result=await api('register',signupPayload,true);
         if(result.passkey_setup){d.password='';$('#p').value='';await completeCitizenSignupPasskey(signupPassword);signupPassword='';return;}
         signupPassword='';const fallback=result.approval_status==='pending'?'Signup received. Your account is pending administrator approval.':'Account created. Sign in to continue.';history.replaceState(null,'',`#portal/${portalRole}/login`);return login(result.message||fallback);
       }
       const loginPayload=portalRole==='citizen'?new FormData(form):{...d,role:portalRole};
       if(portalRole==='citizen')loginPayload.set('role',portalRole);
       const result=await api('login',loginPayload,portalRole==='citizen');
       d.password='';
       if(result.two_step_required){
         pendingTwoStepUsername=String(d.username||'').trim();
         const passwordInput=$('#p'), retry=$('#two-step-verify');
         if(passwordInput)passwordInput.value='';
         err.textContent='Step 2 of 2: verify this sign-in with your device passkey.';
         if(retry)retry.hidden=false;
         form.dataset.submitting='false';button.disabled=false;button.innerHTML='Secure sign in <span aria-hidden="true">→</span>';
         return;
       }
       if(result.csrf)csrf=result.csrf;location.hash='app';await load(true);
     }catch(x){d.password='';if(app.contains(form)){form.dataset.submitting='false';err.textContent=x.error||'Could not complete sign in. Check your details and try again.';button.disabled=false;button.innerHTML=`${setup?'Create administrator account':reg?'Create account':'Secure sign in'} <span aria-hidden="true">→</span>`;}}
  };
}

async function load(force) {
  if (window.AdminSetup?.isActive()) return;
  if (backupBusy || reportDownloads || S && !force && hasHeldInterface()) return;
  try { const n = await api('state'); if (window.AdminSetup?.isActive() || !force && (backupBusy || reportDownloads || hasHeldInterface())) return; const comparable = {...n}; delete comparable.now; const j = JSON.stringify(comparable); connectionError = ''; if (!force && j === seen) { S = n; tickClock(); clearConnectionBanner(); return; } seen = j; S = n; render(); resumeLocationTracking(); }
  catch (e) { if (S) showConnectionBanner(e.error || 'Live updates are temporarily unavailable.'); }
}
function showConnectionBanner(message) {
  connectionError = message;
  let banner = $('#connection-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connection-banner';
    banner.className = 'connection-banner';
    banner.setAttribute('role', 'alert');
    const main = $('.app-main');
    if (main) main.prepend(banner);
  }
  banner.innerHTML = `<span>${esc(connectionError)} Live data may be out of date.</span><button type="button" id="retry-state">Retry connection</button>`;
}
function clearConnectionBanner() { $('#connection-banner')?.remove(); }
const tabs = {citizen: ['dashboard', 'report', 'affidavits', 'certifications'], officer: ['dashboard', 'queue', 'mine', 'requests'], admin: ['dashboard', 'cases', 'requests', 'users', 'audit', 'reports', 'settings']};
const label = {dashboard:'Dashboard', cases: 'Cases', report: 'Report crimes', affidavits:'Request affidavit', certifications:'Certify documents', requests: 'Service requests', security: 'Account security', queue: 'Unassigned cases', mine: 'My cases', users: 'Manage users', audit: 'Audit log', reports: 'Operational reports', settings: 'Settings'};
function render() {
  document.body.classList.remove('home-glass');
  document.body.classList.add('workspace-theme');
  window.AdminDashboard?.dispose();
  const r = S.me.role;
  // Keep case-progress links and post-report navigation available without a Citizen Cases tab.
  if (!tabs[r].includes(tab) && !(r === 'citizen' && tab === 'cases')) tab = tabs[r][0];
   if (r !== 'citizen') window.CitizenServices?.stopLocation();
  const open = S.sos.filter(s => s.status === 'Open').length;
   const alertBanner = r === 'officer' && tab === 'dashboard' && open ? `<div class="flash officer-sos-notice" role="alert">${open} open SOS alert${open > 1 ? 's' : ''}. Review the alerts below.</div>` : r === 'admin' && open ? `<div class="flash" role="status">${open} open SOS alert${open > 1 ? 's' : ''}. Officers can review and respond from the Officer Dashboard.</div>` : '';
  if (r !== 'citizen' && open > openSos && openSos >= 0) beep(); openSos = open;
    app.innerHTML = `<div class="app-shell"><header class="app-top"><a href="#home" class="app-brand"><span class="brand-mark">SP</span><span>SMART<span class="brand-light">POLICE</span><small>COMMUNITY SAFETY PLATFORM</small></span></a><div class="app-tools"><span class="live-status"><i></i> Live updates</span><time id="liveClock"></time><span class="user-pill">${esc(S.me.name)} <b>${esc(r)}</b></span><button class="tool-button" id="pw" type="button">Change password</button><button class="tool-button" id="lo" type="button">Sign out</button></div></header>
      <nav class="app-nav" aria-label="Workspace sections">${tabs[r].map(t => `<button type="button" data-tab="${t}" aria-current="${t === tab}" title="${label[t]}">${t === 'dashboard' && r === 'citizen' ? 'Citizen Dashboard' : label[t]}</button>`).join('')}</nav><main class="app-main">${alertBanner}${view(r)}</main>${passwordDialog()}</div>`;
   window.CitizenServices?.syncDashboard(r === 'citizen' && tab === 'dashboard');
   appendCitizenContactToUserRows();
  appendUserSuspensionControls();
  const staffUsername=$('#user-username'),staffUsernameHelp=$('#user-name-help'),userPasswordHelp=$('#user-password-help'),changePasswordHelp=$('#new-password-help');
  if(staffUsername){staffUsername.removeAttribute('minlength');staffUsername.maxLength=160;staffUsername.removeAttribute('aria-describedby');}
  staffUsernameHelp?.remove();
  if(userPasswordHelp)userPasswordHelp.textContent='Use 5–8 characters.';
  if(changePasswordHelp)changePasswordHelp.textContent='Use 5–8 characters.';
  tickClock();
  if (r === 'admin' && tab === 'dashboard') window.AdminDashboard?.mount(S);
  if (connectionError) showConnectionBanner(connectionError);
}
function appendCitizenContactToUserRows() {
  if (tab !== 'users' || S.me.role !== 'admin') return;
  const rows = [...document.querySelectorAll('.app-main table tbody tr')];
  for (const user of S.users.filter(account => account.role === 'citizen')) {
    const row = rows.find(item => item.cells[1]?.textContent.trim() === user.username);
    if (!row) continue;
    const summary = document.createElement('small');
    summary.className = 'user-contact-summary';
    summary.textContent = `Address: ${user.residential_address || 'Not on file'} · Phone: ${user.phone || 'Not on file'} · Email: ${user.email || 'Not on file'}`;
    row.cells[0].append(summary);
  }
}
function appendUserSuspensionControls() {
  if (tab !== 'users' || S.me.role !== 'admin') return;
  const rows = [...document.querySelectorAll('.app-main table tbody tr')];
  for (const officer of S.users.filter(account => ['officer','admin','citizen'].includes(account.role))) {
    const row = rows.find(item => item.cells[1]?.textContent.trim() === officer.username);
    if (!row) continue;
    if (+officer.suspended) {
      const status = document.createElement('small');
      status.className = 'officer-suspension-summary';
      status.textContent = `Suspended${officer.suspended_at ? ` · ${when(officer.suspended_at)}` : ''}: ${officer.suspension_reason || 'No reason recorded'}`;
      row.cells[4]?.append(document.createElement('br'), status);
    }
    if (+officer.id === +S.me.id) continue;
    const accountRole = {officer:'Officer',admin:'Admin',citizen:'Citizen'}[officer.role];
    const details = document.createElement('details');
    details.className = 'officer-suspension';
    const decision = +officer.suspended ? 'reinstate' : 'suspend';
    details.innerHTML = `<summary>${decision === 'suspend' ? 'Suspend' : 'Reinstate'} ${accountRole}</summary><form data-f="${officer.role === 'officer' ? 'officer_suspend' : 'user_suspend'}" novalidate><input type="hidden" name="id" value="${+officer.id}"><input type="hidden" name="decision" value="${decision}">${decision === 'suspend' ? '<label>Suspension reason<textarea name="reason" required minlength="10" maxlength="500" rows="3" placeholder="Explain why this account is being suspended."></textarea></label><small class="field-help">10–500 characters. The reason is retained in the Admin audit history.</small>' : '<p class="field-help">Reinstating restores sign-in. The original suspension reason stays in the account history.</p>'}<p class="form-error" role="alert" aria-live="polite"></p><button type="submit">${decision === 'suspend' ? 'Confirm suspension' : 'Reinstate account'}</button></form>`;
    row.cells[6]?.append(details);
  }
}
function beep() { try { const c = new AudioContext(), o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(); o.stop(c.currentTime + .4); } catch (e) {} }

function view(r) {
  const cs = S.cases;
  if (r === 'citizen' && ['dashboard','affidavits','certifications'].includes(tab)) return CitizenServices.citizenView(tab, S, esc, when);
  if (tab === 'requests' && r !== 'citizen') return CitizenServices.staffView(S, esc, when);
  if (r === 'citizen' && tab === 'cases') return CitizenServices.citizenCases(S, esc, when, cs, caseCard);
  if (tab === 'report') return `<section class="section-heading"><span class="eyebrow">CITIZEN SERVICES</span><h1>Report an incident</h1><p>Tell us what happened and where. An Officer can review your report and you can follow its progress in Cases &amp; progress.</p></section><form class="panel" data-f="report" novalidate><p class="form-intro">Fields marked as required must be completed before you send your report.</p><label for="report-title">Short incident title</label><input id="report-title" name="title" required minlength="3" maxlength="120" aria-describedby="report-title-help" placeholder="For example, bicycle taken from campus"><small id="report-title-help" class="field-help">3–120 characters. Keep it short and do not include passwords or account details.</small>
    <label for="report-type">Incident type</label><select id="report-type" name="type">${incidentTypes.map(x => `<option>${x}</option>`).join('')}</select>
    <label for="report-description">Describe what happened</label><textarea id="report-description" name="description" required minlength="10" maxlength="4000" aria-describedby="report-description-help"></textarea><small id="report-description-help" class="field-help">10–4,000 characters. Share what you saw, when it happened and any useful details. Stick to facts you know.</small><label for="report-location">Where did it happen? <span class="optional-label">Optional</span></label><input id="report-location" name="location" maxlength="200" aria-describedby="report-location-help" placeholder="A nearby address, building or landmark"><small id="report-location-help" class="field-help">Share a nearby place if known. This does not use your live GPS location.</small><p class="form-error" role="alert" aria-live="polite"></p><p class="form-submit-note">After submission, the report will appear in Cases &amp; progress.</p><p><button type="submit">Submit incident report</button></p></form>`;
  if (tab === 'sos') return r === 'citizen' ? sosCitizen() : sosStaff();
  if (tab === 'security' && r === 'citizen') return citizenSecurityView();
  if (tab === 'dashboard') return r === 'officer' ? officerDash() : dash();
  if (tab === 'users') return users();
  if (tab === 'audit') return `<h2>Audit log</h2><div class="scroll panel"><table><tr><th>When<th>Who<th>Action<th>Detail<th>From</tr>${S.audit.map(a => `<tr><td>${when(a.ts)}<td>${esc(a.username || '-')}<td>${esc(a.action)}<td>${esc(a.detail)}<td>${esc(a.ip)}<br><small>${esc((a.ua || '').slice(0, 60))}</small></tr>`).join('')}</table></div>`;
  if (tab === 'reports') return reportsView();
  if (tab === 'settings') return settingsView();
  let list = cs; if (tab === 'queue') list = cs.filter(c => !c.officer_id && c.status !== 'Closed'); if (tab === 'mine') list = cs.filter(c => c.officer_id === S.me.id);
  return `<section class="section-heading"><span class="eyebrow">${r === 'citizen' ? 'YOUR RECORDS' : 'CASE WORKSPACE'}</span><h1>${label[tab]}</h1><p>${tab === 'queue' ? 'Review unassigned reports and take a case when you are ready to handle it.' : tab === 'mine' ? 'Follow your assigned cases, evidence, affidavits and next steps.' : r === 'citizen' ? 'Follow reports, current status and case updates here.' : 'Review incident reports, supporting records and case progress.'}</p></section>` + (list.length ? list.map(caseCard).join('') : `<div class="empty">${r === 'citizen' ? 'No incident reports yet. Choose “Report crimes” to send your first report. After submission, check back here for its status.' : tab === 'queue' ? 'There are no unassigned cases right now. New cases will appear here when they are ready for an Officer.' : tab === 'mine' ? 'You do not have any assigned cases yet. Check the unassigned queue for available cases.' : 'No cases are available right now.'}</div>`);
}
const operationalReports = [
  ['cases', 'Case register', 'Filed cases and their recorded details.'],
  ['status', 'Case status summary', 'Case counts grouped by current status.'],
  ['officers', 'Officer workload', 'Assignments and workload based on case filing dates.'],
  ['sos', 'SOS activity', 'SOS alerts and response activity.'],
  ['audit', 'Audit activity', 'Recorded account and system actions, filtered by event time.']
];
function reportsView() {
  return `<section class="section-heading"><span class="eyebrow">RECORDS & OVERSIGHT</span><h1>Operational reports</h1><p>Generate dated activity reports for cases, status, officer workload, SOS alerts, and audit events. PDF exports are saved in Settings so Admin can download them again.</p></section>
    <section class="panel report-filters"><h2>Report date range</h2><p>Choose an optional inclusive date range using Johannesburg calendar dates. Cases and status use case creation; SOS uses alert creation; officer workload uses case creation with current assignment and includes officers with no assigned cases; audit uses event time.</p><div class="date-range"><div><label for="report-from">From date</label><input id="report-from" type="date" value="${esc(reportFrom)}"></div><div><label for="report-to">To date</label><input id="report-to" type="date" value="${esc(reportTo)}"></div></div><p class="form-error" id="operational-report-error" role="alert" aria-live="polite"></p></section>
    <div class="operational-report-list">${operationalReports.map(([type,title,help])=>`<article class="export-card operational-report"><span class="export-icon">DATA</span><div><h2>${title}</h2><p>${help}</p><small>PDF for saved records, or CSV for spreadsheets.</small></div><div class="report-links"><a class="button-link report-download" data-report-type="${type}" data-format="pdf" href="${reportUrl(type,'pdf')}">PDF</a><a class="button-link button-secondary report-download" data-report-type="${type}" data-format="csv" href="${reportUrl(type,'csv')}">CSV</a></div></article>`).join('')}</div>
    <button type="button" class="ghost" data-tab="settings">Open Settings and saved PDFs</button>`;
}
function settingsView() {
  const connected = !connectionError;
  const exports = S.pdfExports || [];
  const roster = S.registrationRoster || {};
  const rosterState = roster.synced ? 'Up to date' : roster.error ? 'Sync needs attention' : 'Not synced yet';
  return `<section class="section-heading"><span class="eyebrow">SYSTEM CONTROL</span><h1>Settings</h1><p>Check system synchronization, create backups, and retrieve saved PDF records.</p></section><section class="settings-grid">
    <section class="panel"><h2>Live synchronization</h2><p><span class="chip ${connected ? 'Resolved' : 'Open'}">${connected ? 'Connected' : 'Needs attention'}</span></p><p>Admin data refreshes automatically every 3 seconds while this page is open. Last successful server snapshot: ${when(S.now)}.</p><p>${connected ? 'The current session is connected to the live application database.' : `Last sync issue: ${esc(connectionError)}`}</p><a class="button-link" href="api.php?a=settings_pdf">Save settings, sync status, and recent activity as PDF ↗</a></section>
    <section class="panel"><div class="row"><h2>OneDrive database copy</h2><span class="chip ${roster.synced ? 'Resolved' : 'Open'}">${rosterState}</span></div><p>The existing Smart_Police_Registrations.xlsx file keeps its name. Its worksheets mirror account, case, evidence, affidavit, SOS, audit, PDF-export, and service-request tables. Account contact/address details, case text, and SOS coordinates are included. Passwords, passkey/session secrets, IP/device metadata, encrypted request contents, and uploaded file contents are excluded; file metadata is listed.</p>${roster.web_url ? `<p><a class="button-link" href="${esc(roster.web_url)}" target="_blank" rel="noopener noreferrer">Open OneDrive Excel copy ↗</a></p>` : ''}${roster.last_sync ? `<p class="meta">Last synced ${when(roster.last_sync)} · ${Number(roster.sheet_count)||0} sheets · ${Number(roster.row_count)||0} records</p>` : ''}<p id="registration-roster-status" class="form-error" role="status" aria-live="polite">${roster.error ? esc(roster.error) : roster.synced ? 'System database changes sync automatically.' : 'Sync now to create the workbook from existing database records.'}</p><button type="button" class="ghost" data-do="sync-registration-roster">Sync database now</button></section>
    <section class="panel"><h2>Backup and recovery</h2><p>Keep both a readable PDF snapshot and a separate encrypted archive that can restore the database and attachments.</p><div class="dashboard-shortcuts"><a class="button-link" href="api.php?a=backup_pdf">Save full record backup as PDF ↗</a></div>
      <form id="backup-form"><label for="backup-password">Your current administrator account password</label><input id="backup-password" name="password" type="password" autocomplete="current-password" maxlength="16" required aria-describedby="backup-account-help"><small id="backup-account-help" class="field-help">Account passwords are 5–8 Unicode characters. This is separate from your backup passphrase.</small>
      <label for="backup-passphrase">New backup passphrase</label><input id="backup-passphrase" name="passphrase" type="password" autocomplete="new-password" maxlength="1024" required aria-describedby="backup-passphrase-help"><small id="backup-passphrase-help" class="field-help">Use 16–1,024 UTF-8 bytes. This recovery passphrase is separate from account passwords, which must be 5–8 Unicode characters.</small>
      <label for="backup-confirm">Confirm backup passphrase</label><input id="backup-confirm" name="confirm" type="password" autocomplete="new-password" maxlength="1024" required>
      <p>Store the passphrase separately in a password manager. Losing it makes this backup unrecoverable. Use HTTPS for downloads.</p><p><button type="submit">Create encrypted recovery backup</button></p><p id="backup-status" role="status" aria-live="polite"></p></form>
      <p class="legal-note">The encrypted archive is removed from the server after download. Keep an off-site copy and verify recovery regularly. Restoring replaces current records; follow the recovery guide.</p></section></section>
    <section class="panel"><h2>Saved PDF archive</h2><p>Operational reports, full record backups, case PDFs, and settings snapshots are retained securely and included in the encrypted recovery archive.</p>${exports.length ? `<div class="scroll"><table><thead><tr><th>PDF file</th><th>Created by</th><th>Created</th><th>Download</th></tr></thead><tbody>${exports.map(file=>`<tr><td>${esc(file.filename)}</td><td>${esc(file.created_by || 'Administrator')}</td><td>${when(file.created)}</td><td><a class="button-link" href="api.php?a=pdf_export_download&id=${+file.id}">Download PDF</a></td></tr>`).join('')}</tbody></table></div>` : '<p class="meta">No PDFs saved yet. Create a report or backup PDF to start the archive.</p>'}</section>`;
}
function citizenSecurityView() {
  const hasPasskey = !!S.me.has_passkey, twoStepEnabled = !!S.me.two_step_enabled;
  const details = twoStepEnabled
    ? 'Your password and device verification are required at every sign-in.'
    : hasPasskey
      ? 'Turn this on to require your password and device verification at every sign-in.'
      : 'Turn this on to set up and verify a passkey. Your device will use Face ID when available.';
  const twoStep = `<section class="panel"><h2>Two-step verification</h2><p>${details}</p><p class="meta">Face ID is available on supported devices. Other devices may use their supported secure verification method. Verification stays on your device.</p><p><span class="chip ${twoStepEnabled ? 'Resolved' : 'Open'}">${twoStepEnabled ? 'Enabled' : 'Not enabled'}</span></p><form id="two-step-form" novalidate><label for="two-step-password">Current password</label><div class="password-field"><input id="two-step-password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button type="button" class="password-toggle" data-password-target="two-step-password" aria-label="Show current password" aria-pressed="false">Show</button></div><p class="form-error" role="alert" aria-live="polite"></p><button type="submit" data-two-step-enabled="${twoStepEnabled ? 'true' : 'false'}">${twoStepEnabled ? 'Disable two-step verification' : 'Enable two-step verification'}</button></form></section>`;
  const facePhoto = `<section class="panel"><h2>Citizen camera photo</h2><p>${S.me.has_face_photo?'A photo is stored for authorised human review. You can replace it with a new camera capture.':'Capture a camera photo for Admin and assigned Officer review of your service requests.'}</p><form data-f="face_photo_update" data-file novalidate>${window.FaceCamera.markup()}<label class="service-consent"><input type="checkbox" name="face_consent" value="yes" required> I agree to store this camera photo securely for human review by Admins and assigned Officers.</label><p class="field-help">This photo is not used for automated face recognition or face-to-ID matching.</p><p class="form-error" role="alert" aria-live="polite"></p><button type="submit">${S.me.has_face_photo?'Replace camera photo':'Save camera photo'}</button></form></section>`;
  const phoneOtp = `<section class="panel"><h2>Phone OTP demonstration</h2><p>Try a code for your registered +27 number. No SMS is sent. This demonstration does not replace secure two-step sign-in.</p><form id="phone-otp-send"><p class="form-error" role="alert"></p><button type="submit">Send demo code</button></form><form id="phone-otp-verify"><label for="phone-otp-code">6-digit code</label><input id="phone-otp-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><p class="form-error" role="status" aria-live="polite"></p><button type="submit">Verify demo code</button></form></section>`;
  return `<section class="section-heading"><span class="eyebrow">ACCOUNT SECURITY</span><h1>Account security</h1><p>Protect your sign-ins with two-step verification.</p></section>${twoStep}${phoneOtp}${facePhoto}`;
}
function reportUrl(type, format) {
  const from = $('#report-from')?.value || reportFrom, to = $('#report-to')?.value || reportTo;
  const q = new URLSearchParams({a:'operational_report', type, format});
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return `api.php?${q.toString()}`;
}
function caseCard(c) {
  const r = S.me.role, staff = r !== 'citizen', closed = c.status === 'Closed', mine = c.officer_id === S.me.id;
  const ctl = [];
  if (r === 'officer' && !c.officer_id && !closed) ctl.push(`<button data-do="take" data-id="${c.id}">Take this case</button>`);
  if (r === 'admin' && !closed) ctl.push(`<form class="inline" data-f="assign"><input type="hidden" name="case_id" value="${c.id}"><select name="officer_id">${S.officers.map(o => `<option value="${o.id}" ${o.id === c.officer_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select><button>${c.officer_id ? 'Reassign' : 'Assign officer'}</button></form>`);
  if (staff && c.officer_id && !closed && (mine || r === 'admin')) ctl.push(`<form class="inline" data-f="status"><input type="hidden" name="case_id" value="${c.id}"><select name="status">${['Assigned', 'Evidence Collection', 'Closed'].map(s => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select><button>Update status</button></form>`);
  const ev = c.evidence.map(e => `<div class="row"><span>${esc(e.filename)} <small>${kb(e.size)}</small> <span class="chip ${e.status}">${e.status}</span>${e.note ? `<br><small>Note: ${esc(e.note)}</small>` : ''}</span><span class="acts">${staff ? `<button type="button" class="ghost" data-document-viewer-url="api.php?a=download&amp;t=evidence&amp;id=${e.id}&amp;preview=1" data-document-viewer-name="${esc(e.filename)}">View</button>` : ''}<a href="api.php?a=download&t=evidence&id=${e.id}"><button class="ghost" type="button">Download</button></a>${staff && e.status === 'Pending' && !closed ? `<button class="ok" data-do="approve" data-id="${e.id}">Approve</button><button class="bad" data-do="reject" data-id="${e.id}">Reject</button>` : ''}</span></div>`).join('');
  const af = c.affidavits.map(a => `<div class="row"><span>Affidavit from ${when(a.created)} <span class="chip ${a.status}">${a.status}</span>${a.certified_at?`<small class="stamp-time">Certified ${when(a.certified_at)} · server time (Johannesburg)</small>`:''}${a.sha256?`<small class="stamp-time">Source document SHA-256: ${esc(a.sha256)}</small>`:''}</span><span class="acts">${staff ? `<button type="button" class="ghost" data-document-viewer-url="api.php?a=download&amp;t=affidavit&amp;id=${a.id}&amp;preview=1" data-document-viewer-name="Affidavit ${esc(c.ref)}">View affidavit</button>` : ''}${a.status === 'Certified' ? `<a href="api.php?a=download&t=affidavit&id=${a.id}"><button class="ghost" type="button">Download stamped PDF</button></a>` : ''}${r === 'officer' && a.status === 'Pending' ? `<a href="api.php?a=download&t=affidavit&id=${a.id}"><button class="ghost" type="button">Read</button></a><button class="ok" data-do="certify" data-id="${a.id}">Certify and stamp</button>` : ''}</span></div>`).join('');
  const contact = staff ? `<div class="citizen-contact"><span><b>Residential address</b>${esc(c.citizen_address||'Not on file')}</span><span><b>Phone</b>${c.citizen_phone?`<a href="tel:${esc(c.citizen_phone)}">${esc(c.citizen_phone)}</a>`:'Not on file'}</span><span><b>Email</b>${c.citizen_email?`<a href="mailto:${encodeURIComponent(c.citizen_email)}">${esc(c.citizen_email)}</a>`:'Not on file'}</span></div>` : '';
  return `<article class="case"><header><div><h3>${esc(c.title)}</h3><p class="meta"><span>${c.ref}</span><span>${esc(c.type)}</span><span>Filed ${when(c.created)}</span>${staff ? `<span>By ${esc(c.citizen_name)}</span>` : ''}<span>Officer: ${esc(c.officer_name || 'not yet assigned')}</span></p></div><span class="chip ${c.status.split(' ')[0]}">${c.status}</span></header>${contact}${r === 'citizen' ? `<a class="case-pdf-link" href="api.php?a=case_pdf&id=${c.id}">Download timestamped case PDF ↗</a>` : ''}
  <p>${esc(c.description)}</p>${c.location ? `<p class="meta">Location: ${esc(c.location)}</p>` : ''}${ctl.length ? `<div class="sub">${ctl.join('')}</div>` : ''}
  <div class="sub"><b>Evidence</b>${ev || '<p class="meta">None uploaded.</p>'}${closed ? '' : `<form class="inline" data-f="evidence_upload" data-file><input type="hidden" name="case_id" value="${c.id}"><input type="file" name="file" required><button>Upload evidence</button></form>`}</div>
  <div class="sub"><b>Affidavits</b>${af || '<p class="meta">None submitted.</p>'}${r === 'citizen' && !closed ? `<details><summary>Submit an affidavit</summary><form data-f="affidavit_upload" data-file><input type="hidden" name="case_id" value="${c.id}"><label>Statement (plain text)</label><textarea name="text"></textarea><label>Or a .txt file</label><input type="file" name="file" accept=".txt,text/plain"><p><button>Send for certification</button></p></form></details>` : ''}</div>
  <div class="sub"><b>Progress</b><ol class="tl">${c.events.map(e => `<li><time>${when(e.ts)}</time>${esc(e.text)} <small>${esc(e.by_name)}</small></li>`).join('')}</ol></div></article>`;
}
function sosCitizen() {
  const mine = S.sos.find(s=>s.status==='Open'||s.status==='Responding')||S.sos[0];
  return `<section class="section-heading"><span class="eyebrow">SOS COORDINATION</span><h1>Emergency assistance</h1><p>Send an SOS alert and share your current location with responding staff.</p></section><div class="notice-panel"><strong>Immediate danger?</strong><span>This website does not contact emergency dispatch. Contact your local emergency number when you need urgent assistance.</span></div><div class="sos-action-card"><div class="sos-action-copy"><span class="eyebrow">${mine&&(mine.status==='Open'||mine.status==='Responding')?'ACTIVE ALERT':'EMERGENCY ALERT'}</span><h2>${mine&&(mine.status==='Open'||mine.status==='Responding')?'Location sharing is active.':'Need help?'}</h2><p>${mine&&(mine.status==='Open'||mine.status==='Responding')?'Your GPS location is shared while this alert remains active.':'Send an alert with your current GPS location. Location access may require HTTPS and your permission.'}</p></div><button class="sosbtn" data-do="sos">${mine&&(mine.status==='Open'||mine.status==='Responding')?'Update my location':'Send SOS'}</button></div><p id="sos-location-error" class="form-error" role="status" aria-live="polite"></p>`+
    (mine ? `<div class="panel"><b>Latest alert</b><div class="row"><span>Raised ${when(mine.created)} · Updated ${when(mine.updated)}</span><span class="chip ${mine.status}">${mine.status === 'Responding' ? 'Officers are responding' : mine.status}</span></div>${liveMap(mine,true)}</div>` : '');
}
const map = s => s.lat == null ? '<span class="location-none">No GPS fix recorded</span>' : `<a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${s.lat}/${s.lng}" target="_blank" rel="noopener noreferrer">${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}</a>`;
function liveMap(s,citizen=false){
 if(s.lat==null||s.lng==null)return `<div class="map-unavailable">No GPS location is available.${citizen&&s.status!=='Resolved'?' <button class="ghost" data-do="retry-location">Try location again</button>':''}</div>`;
 const lat=+s.lat,lng=+s.lng,d=.008,src=`https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(`${lng-d},${lat-d},${lng+d},${lat+d}`)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lng}`)}`;
 return `<div class="live-location"><iframe title="Map of reported incident location" loading="lazy" referrerpolicy="no-referrer" src="${src}"></iframe><div class="location-meta"><span>LIVE GPS LOCATION</span><b>${lat.toFixed(5)}, ${lng.toFixed(5)}</b><small>Last update ${when(s.updated)}</small><a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}" target="_blank" rel="noopener noreferrer">Open full map ↗</a></div><small class="legal-note">Map tiles are provided by OpenStreetMap. Loading this map shares the displayed coordinates with its map service.</small></div>`;
}
function sosStaff() {
  return `<section class="section-heading"><span class="eyebrow">SOS COORDINATION</span><h1>Live SOS alerts</h1><p>Review citizen alerts, respond to active incidents, and follow live GPS updates while an alert remains active.</p></section>` + (S.sos.length ? S.sos.map(s => `<div class="panel sos-panel ${s.status === 'Open' ? 'alert' : ''}"><div class="row"><span><b>${esc(s.citizen_name)}</b><br><small>Raised ${when(s.created)}, location updated ${when(s.updated)}</small><br>${map(s)}</span><span class="acts"><span class="chip ${s.status}">${s.status}</span>${s.status === 'Open' ? `<button data-do="ack" data-id="${s.id}">Respond</button>` : ''}${s.status !== 'Resolved' ? `<button class="ghost" data-do="resolve" data-id="${s.id}">Mark resolved</button>` : ''}</span></div>${liveMap(s)}</div>`).join('') : '<div class="empty">No alerts.</div>');
}
function officerDash() {
  const cases = S.cases || [], requests = S.requests || [], sos = S.sos || [];
  const mine = cases.filter(c => Number(c.officer_id) === Number(S.me.id));
  const activeMine = mine.filter(c => c.status !== 'Closed');
  const unassigned = cases.filter(c => !c.officer_id && c.status !== 'Closed');
  const pendingReviews = requests.filter(r => Number(r.officer_id) === Number(S.me.id) && r.status === 'In review');
  const activeSos = sos.filter(s => s.status === 'Open' || s.status === 'Responding');
  return `<section class="section-heading"><span class="eyebrow">OFFICER WORKSPACE</span><h1>Overview</h1><p>See your assigned cases, service requests for review and active citizen alerts.</p></section>
    <section class="kpis officer-kpis" aria-label="Officer workload summary">
      <div class="panel"><b>${activeMine.length}</b>my active cases</div>
      <div class="panel"><b>${unassigned.length}</b>available unassigned cases</div>
      <div class="panel"><b>${pendingReviews.length}</b>my pending service reviews</div>
      <div class="panel"><b>${activeSos.length}</b>active SOS alerts</div>
    </section>
    <section class="panel officer-shortcuts"><div class="row"><div><h2>Go to work</h2><p class="meta">Open your case queue or service review list.</p></div><div class="dashboard-shortcuts">
      <button type="button" class="ghost" data-tab="mine">My cases (${activeMine.length})</button>
      <button type="button" class="ghost" data-tab="queue">Unassigned queue (${unassigned.length})</button>
      <button type="button" class="ghost" data-tab="requests">Service requests (${pendingReviews.length})</button>
    </div></div></section>
    <section class="officer-sos-area" aria-label="Officer SOS alerts">${sosStaff()}</section>`;
}
function dash() {
  const st = S.stats;
  const bars = (a) => { const m = Math.max(1, ...a.map(x => Number(x.n)||0)); return a.map(x => `<div class="bar"><span>${esc(x.k)}</span><i style="width:${Math.max(0,Number(x.n)||0) / m * 100}%"></i><b>${Number(x.n)||0}</b></div>`).join('') || '<p class="meta">No data yet.</p>'; };
  const alerts = [
    [st.pendingAccounts, 'Accounts awaiting approval', 'users'],
    [st.flaggedCitizenAccounts, 'Citizen accounts flagged for review', 'users'],
    [st.pendingEvidence, 'Evidence awaiting review', 'cases'],
    [st.pendingAffidavits, 'Affidavits awaiting certification', 'cases'],
    [st.unassignedCases, 'Open cases without an officer', 'cases']
  ].filter(([count]) => count > 0);
  const recent = S.audit.slice(0, 8);
  return `<section class="section-heading"><span class="eyebrow">ADMIN WORKSPACE</span><h1>Overview</h1><p>Review system activity, account approvals, cases, evidence and service requests.</p></section>
    <section class="kpis">
      <div class="panel"><b>${st.totalCases}</b>total cases</div><div class="panel"><b>${st.activeSos}</b>active SOS alerts</div><div class="panel"><b>${st.totalEvidence}</b>evidence files</div><div class="panel"><b>${st.pendingEvidence}</b>evidence awaiting review</div><div class="panel"><b>${st.activeCitizens}</b>active Citizens</div><div class="panel"><b>${st.activeOfficers}</b>active Officers</div><div class="panel"><b>${st.activeAdmins}</b>active Admins</div>
    </section>
    <section class="panel"><div class="row"><h2>System alerts</h2>${alerts.length ? `<span class="chip Open">${alerts.length} need attention</span>` : '<span class="chip Resolved">All clear</span>'}</div>
      ${connectionError ? `<div class="flash" role="alert">Live sync needs attention: ${esc(connectionError)}</div>` : ''}
      ${alerts.length ? `<div class="dashboard-alerts">${alerts.map(([count,title,target])=>`<button type="button" class="dashboard-alert" data-tab="${target}"><b>${count}</b><span>${title}</span><span aria-hidden="true">→</span></button>`).join('')}</div>` : '<p class="meta">No open alerts or reviews are waiting.</p>'}
    </section>
    <section class="admin-dashboard-grid" aria-label="Live administration graphs">
      <section class="panel admin-chart-panel"><h2>Cases by status</h2><p class="admin-chart-subtitle">Current totals from all recorded cases</p><div id="admin-cases-status" aria-label="${(st.status||[]).map(x=>`${esc(x.k)}: ${Number(x.n)||0}`).join('; ')||'No case status counts'}"></div></section>
      <section class="panel admin-chart-panel"><h2>Active users by role</h2><p class="admin-chart-subtitle">Current active account totals</p><div id="admin-users-chart" class="admin-chart" role="img" aria-label="Active users by role chart"></div><ul id="admin-users-chart-counts" class="admin-chart-counts" aria-label="Active user counts"></ul></section>
      <section class="panel admin-chart-panel admin-crime-panel"><h2>Crime stats</h2><p class="admin-chart-subtitle">Current incident counts by reported type</p><div id="admin-crime-chart" class="admin-chart" role="img" aria-label="Crime type distribution chart"></div><p id="admin-crime-caption" class="admin-chart-subtitle" aria-live="polite"></p><h3>Full crime type breakdown</h3><ul id="admin-crime-chart-counts" class="admin-chart-counts admin-crime-breakdown" aria-label="Full crime type and case count breakdown"></ul></section>
      <section class="panel admin-activity-panel"><h2>Recent portal activity</h2><p class="meta">Latest recorded actions across Citizen, Officer, and Admin accounts.</p>${recent.length ? `<ul class="activity-list">${recent.map(a=>`<li><time>${when(a.ts)}</time><b>${esc(a.username||'System')}</b><span>${esc(a.action)}${a.detail ? ` · ${esc(a.detail)}` : ''}</span></li>`).join('')}</ul>` : '<p class="meta">No activity recorded yet.</p>'}</section>
    </section>
    <section class="panel"><h2>Administration</h2><div class="dashboard-shortcuts"><button type="button" class="ghost" data-tab="cases">Manage cases and evidence</button><button type="button" class="ghost" data-tab="users">Manage users</button><button type="button" class="ghost" data-tab="reports">Operational reports</button><button type="button" class="ghost" data-tab="settings">Settings and backups</button></div></section>`;
}
function users() {
  const statusLabel = status => ({active:'Active',pending:'Pending approval',rejected:'Rejected'}[status] || 'Active');
  return `<section class="section-heading"><span class="eyebrow">ACCESS MANAGEMENT</span><h1>Manage users</h1><p>Review signups, see full names and email addresses, add Admins or Officers, and suspend or reinstate accounts with a recorded reason.</p></section>
    <form class="panel user-create-form" data-f="admin_add" novalidate>
      <h2>Add Admins</h2>
      <div><label for="user-name">Full name</label><input id="user-name" name="name" placeholder="Full name" autocomplete="name" maxlength="80" required></div>
      <div><label for="admin-username">Username</label><input id="admin-username" name="username" placeholder="Username for sign-in" autocomplete="off" maxlength="160" required></div>
      <div><label for="user-email">Email (@admin.co.za)</label><input id="user-email" name="email" type="email" maxlength="254" autocomplete="email" aria-describedby="user-email-help" placeholder="name@admin.co.za" required><small id="user-email-help" class="field-help">Use an email ending @admin.co.za. The setup link is shown once and is not emailed.</small></div>
      <p class="form-error" role="alert" aria-live="polite"></p><button type="submit">Add account</button>
    </form>
    <form class="panel user-create-form" data-f="officer_add" novalidate>
      <h2>Add Officer</h2>
      <p class="field-help">The Officer chooses a password using a private setup link. Their account is active once added.</p>
      <div><label for="officer-name">Full name</label><input id="officer-name" name="name" placeholder="Full name" autocomplete="name" maxlength="80" required></div>
      <div><label for="officer-username">Username</label><input id="officer-username" name="username" placeholder="Username for sign-in" autocomplete="off" maxlength="160" required></div>
      <div><label for="officer-email">Officer email</label><input id="officer-email" name="email" type="email" maxlength="254" autocomplete="email" placeholder="officer@example.com" required></div>
      <p class="form-error" role="alert" aria-live="polite"></p><button type="submit">Add Officer</button>
    </form>
    ${S.users.some(u=>u.role==='citizen'&&u.face_photo_available)?`<section class="panel"><h2>Citizen camera photos</h2><p class="field-help">Stored photos are available to Admins and assigned Officers for human review only.</p><ul class="activity-list">${S.users.filter(u=>u.role==='citizen'&&u.face_photo_available).map(u=>`<li><b>${esc(u.name)}</b><span>${esc(u.email||u.username)}</span><button type="button" class="ghost" data-document-viewer-url="api.php?a=user_face_preview&amp;id=${Number(u.id)}&amp;preview=1" data-document-viewer-name="${esc(u.name)} camera photo">View photo</button></li>`).join('')}</ul></section>`:''}
    <div class="panel scroll"><table><thead><tr><th>Full name</th><th>Username</th><th>Role</th><th>Email</th><th>Approval status</th><th>Created</th><th>Actions</th></tr></thead><tbody>${S.users.length?S.users.map(u=>{const status=u.approval_status||'active', pending=status==='pending'&&['citizen','officer','admin'].includes(u.role), canReset=+u.id!==+S.me.id, expiry=Number(u.setup_expires_at)||0, invited=['admin','officer'].includes(u.role)&&!!u.setup_pending, flagged=!!u.review_flag_reason, inviteState=invited?(expiry&&expiry<Date.now()/1000?'Setup link expired':`Setup pending${expiry?` · expires ${when(expiry)}`:''}`):'';return `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${esc(u.email||'—')}</td><td><span class="approval-status ${esc(status)}">${statusLabel(status)}</span>${flagged?`<div class="service-note"><b>Flagged for Admin review</b><p>${esc(u.review_flag_reason)}</p><small>${esc(u.review_flagged_by_name||'Officer')} · ${when(u.review_flagged_at)}</small></div>`:''}${inviteState?`<small class="setup-invite-status">${esc(inviteState)}</small>`:''}</td><td>${when(u.created)}</td><td>${flagged?`<form data-f="citizen_flag_clear" class="user-reset-form"><input type="hidden" name="id" value="${+u.id}"><p class="form-error" role="alert" aria-live="polite"></p><button type="submit" class="ghost">Clear review flag</button></form>`:''}${pending?`<div class="approval-actions"><button type="button" class="ok" data-approval="approve" data-id="${u.id}">Approve</button><button type="button" class="bad" data-approval="reject" data-id="${u.id}">Reject</button></div>`:''}${invited?`<button type="button" class="ghost" data-staff-reissue="${+u.id}">Reissue setup link</button>`:''}${canReset?`<details class="user-reset"><summary>Reset password</summary><form class="user-reset-form" data-user-reset="${+u.id}" novalidate><div class="reset-fields"><label for="reset-password-${+u.id}">New password for ${esc(u.username)}</label><div class="password-field"><input id="reset-password-${+u.id}" name="password" type="password" autocomplete="new-password" maxlength="16" required aria-describedby="reset-help-${+u.id}"><button type="button" class="password-toggle" data-password-target="reset-password-${+u.id}" aria-label="Show new password" aria-pressed="false">Show</button></div><small id="reset-help-${+u.id}" class="field-help">Use 5–8 Unicode characters. This is an account password, not a backup passphrase.</small><label for="reset-confirm-${+u.id}">Confirm new password</label><input id="reset-confirm-${+u.id}" name="confirm" type="password" autocomplete="new-password" maxlength="16" required><label class="reset-confirm-check" for="reset-confirm-check-${+u.id}"><input id="reset-confirm-check-${+u.id}" name="confirmed" type="checkbox" value="yes" required> I confirm I am resetting this user’s password.</label><button type="submit">Reset password</button></div><button type="button" class="ghost reset-again" data-reset-again hidden>Set another password</button><p class="form-error reset-feedback" role="status" aria-live="polite"></p></form></details>`:'You cannot reset your own password here. Use Change password.'}</td></tr>`;}).join(''):`<tr><td colspan="7"><div class="empty">No accounts yet. Add an Admin or Officer, or review signup requests when they arrive.</div></td></tr>`}</tbody></table><p id="approval-error" class="form-error" role="alert" aria-live="polite"></p></div>`;
}

function clearAdminInvite() {
  const dialog=$('#admin-setup-dialog');
  if(dialog?.open)dialog.close();
  if(dialog){dialog.replaceChildren();delete dialog.dataset.setupUrl;}
}
function showStaffInvite(result) {
  const roleName=result?.role==='officer'?'Officer':'Admin';
  const dialog=$('#admin-setup-dialog'), fragment=String(result?.setup_fragment||'');
  if(!dialog||!/^#admin-setup\/[a-f0-9]{64}$/i.test(fragment)){toast(`${roleName} was added, but the setup link was not returned. Reissue it from the user table.`);return;}
  const url=`${location.origin}${location.pathname}${location.search}${fragment}`;
  dialog.innerHTML=`<button type="button" class="setup-dialog-close" data-admin-invite-close>Close</button><span class="eyebrow">PRIVATE ACCOUNT SETUP</span><h2 id="admin-setup-dialog-title">Share the ${roleName} setup link privately</h2><p>This link is not emailed automatically. Share it only with the ${roleName} you added. It expires in one hour and can be used once.</p><strong class="setup-link-value" id="admin-setup-link-value">${esc(url)}</strong><p class="field-help">Keep this link out of public channels. Closing this dialog clears it from the page.</p><div class="setup-dialog-actions"><button type="button" data-admin-copy>Copy setup link</button><button type="button" class="ghost" data-admin-invite-close>Close</button></div><p class="form-error" role="status" aria-live="polite"></p>`;
  dialog.dataset.setupUrl=url;
  if(!dialog.open)dialog.showModal();
}
document.addEventListener('click', async event => {
  const close=event.target.closest('[data-admin-invite-close]');
  if(close){clearAdminInvite();return;}
  const copy=event.target.closest('[data-admin-copy]');
  if(copy){
    const dialog=$('#admin-setup-dialog'), status=dialog?.querySelector('[role="status"]'), link=dialog?.dataset.setupUrl||'';
    try {
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard access is not available in this browser.');
      await navigator.clipboard.writeText(link);
      if(status)status.textContent='Link copied. Share it privately; it expires in one hour and can be used once.';
    } catch {
      if(status)status.textContent='Copy failed. Select and copy the link above manually, then share it privately.';
      const range=document.createRange(), node=$('#admin-setup-link-value');
      if(node){range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
    }
  }
});
$('#admin-setup-dialog')?.addEventListener('close',clearAdminInvite);

function passwordDialog() {
  return `<dialog id="password-dialog" class="password-dialog" aria-labelledby="password-dialog-title"><form id="password-form" novalidate><button type="button" class="dialog-close" data-dialog-close aria-label="Close password dialog">Close</button><span class="eyebrow">ACCOUNT SECURITY</span><h2 id="password-dialog-title">Change password</h2><p>Choose a unique password you do not use on another site.</p><label for="old-password">Current password</label><div class="password-field"><input id="old-password" name="old" type="password" autocomplete="current-password" required><button type="button" class="password-toggle" data-password-target="old-password" aria-label="Show current password" aria-pressed="false">Show</button></div><label for="new-password">New password</label><div class="password-field"><input id="new-password" name="new" type="password" autocomplete="new-password" maxlength="16" required aria-describedby="new-password-help"><button type="button" class="password-toggle" data-password-target="new-password" aria-label="Show new password" aria-pressed="false">Show</button></div><small id="new-password-help" class="field-help">Every account password must be 5–8 Unicode characters. If your existing password is longer than 8 characters, use the current password here or ask an administrator for a reset.</small><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirm" type="password" autocomplete="new-password" maxlength="16" required><p class="form-error" role="alert" aria-live="polite"></p><div class="dialog-actions"><button type="button" class="ghost" data-dialog-close>Cancel</button><button type="submit">Update password</button></div></form></dialog>`;
}

app.addEventListener('input', e => {
  const form = e.target.closest('form[data-f], form#lf');
  if (form) form.dataset.dirty = 'true';
  if (e.target.matches('#report-from,#report-to')) {
    reportFrom = $('#report-from')?.value || ''; reportTo = $('#report-to')?.value || '';
    document.querySelectorAll('.report-download').forEach(link => { link.href = reportUrl(link.dataset.reportType, link.dataset.format); });
    const from = $('#report-from')?.value, to = $('#report-to')?.value, error = $('#operational-report-error');
    if (error) error.textContent = from && to && from > to ? 'The start date must be on or before the end date.' : '';
  }
});
app.addEventListener('change', e => {
  const changedForm = e.target.closest('form[data-f]');
  if (changedForm) changedForm.dataset.dirty = 'true';
  if (e.target.matches('#user-role')) {
    const form = e.target.closest('.user-create-form');
    const field = form?.querySelector('[data-admin-email-field]');
    const input = field?.querySelector('[name="email"]');
    const isAdmin = e.target.value === 'admin';
    if (field && input) {
      field.hidden = !isAdmin;
      input.disabled = !isAdmin;
      input.required = isAdmin;
      if (!isAdmin) input.value = '';
    }
  }
  if (e.target.matches('#report-from,#report-to')) {
    reportFrom = $('#report-from')?.value || ''; reportTo = $('#report-to')?.value || '';
    document.querySelectorAll('.report-download').forEach(link => { link.href = reportUrl(link.dataset.reportType, link.dataset.format); });
    const from = $('#report-from')?.value, to = $('#report-to')?.value, error = $('#operational-report-error');
    if (error) error.textContent = from && to && from > to ? 'The start date must be on or before the end date.' : '';
  }
});
app.addEventListener('click', async e => {
  const toggle = e.target.closest('[data-password-target]');
  if (toggle) { togglePassword(toggle); return; }
  const closeDialog = e.target.closest('[data-dialog-close]');
  if (closeDialog) { $('#password-dialog')?.close(); return; }
  const resetAgain = e.target.closest('[data-reset-again]');
  if (resetAgain) {
    const form = resetAgain.closest('.user-reset-form');
    if (form) {
      form.querySelector('.reset-fields').hidden = false;
      resetAgain.hidden = true;
      const feedback = form.querySelector('.reset-feedback');
      if (feedback) feedback.textContent = '';
      form.querySelector('[name="password"]')?.focus();
    }
    return;
  }
  const reportLink = e.target.closest('.report-download');
  if (reportLink) { e.preventDefault(); downloadOperationalReport(reportLink); return; }
  const t = e.target.closest('[data-tab],[data-do],[data-approval],[data-admin-reissue],#lo,#pw,#retry-state,#passkey-login,#two-step-verify');
  if (!t) return;
  if (t.id === 'retry-state') { load(true); return; }
  if (t.id === 'passkey-login') { passkeyLogin(t); return; }
  if (t.id === 'two-step-verify') { passkeyLogin(t, pendingTwoStepUsername); return; }
  if (t.id === 'lo') {
    t.disabled = true;
    clearAdminInvite();
    window.CitizenServices?.stopLocation();
    (async () => {
      try { await api('logout', {}); S = null; seen = ''; }
      catch (error) { toast(error.error || 'Could not sign out.'); t.disabled = false; return; }
      try { await refreshCsrf(); history.replaceState(null,'',`#portal/${portalRole}/login`); login(); }
      catch { login('You are signed out, but secure sign-in could not be initialized. Reload this page to try again.'); }
    })();
    return;
  }
  if (t.id === 'pw') { const dialog = $('#password-dialog'); if (!dialog.open) dialog.showModal(); return; }
  if (t.hasAttribute('data-staff-reissue')) {
    t.disabled=true;t.textContent='Creating link…';
    try { const result=await api('admin_setup_reissue',{id:Number(t.dataset.staffReissue)});showStaffInvite(result);await load(true); }
    catch(error){toast(error.error||'Could not reissue the setup link.');t.disabled=false;t.textContent='Reissue setup link';}
    return;
  }
  if (t.dataset.tab) { clearAdminInvite(); tab = t.dataset.tab; if(tab!=='dashboard')window.CitizenServices?.stopLocation(); return render(); }
  if (t.dataset.approval) {
    const row=t.closest('tr'), error=$('#approval-error'), buttons=row?.querySelectorAll('[data-approval]');
    if(error)error.textContent='';
    if(buttons)buttons.forEach(button=>{button.disabled=true;});
    t.textContent=t.dataset.approval==='approve'?'Approving…':'Rejecting…';
    api('user_approval',{id:+t.dataset.id,decision:t.dataset.approval}).then(async()=>{toast(t.dataset.approval==='approve'?'Account approved.':'Signup request rejected.');await load(true);}).catch(failure=>{if(error)error.textContent=failure.error||'Could not update this signup request. Try again.';if(buttons)buttons.forEach(button=>{button.disabled=false;button.textContent=button.dataset.approval==='approve'?'Approve':'Reject';});});
    return;
  }
  const id = +t.dataset.id, d = t.dataset.do;
  if (d === 'citizen-location') { window.CitizenServices.startLocation(); return; }
  if (d === 'citizen-location-stop') { window.CitizenServices.stopLocation(); if(tab==='dashboard')render(); return; }
  if (d === 'take') act(() => api('assign', {case_id: id}), 'Case assigned to you');
  if (d === 'approve') act(() => api('evidence_review', {id, status: 'Approved', note: prompt('Optional note for the citizen') || ''}), 'Evidence approved');
  if (d === 'reject') { const note = prompt('Why is this evidence rejected?'); if (note) act(() => api('evidence_review', {id, status: 'Rejected', note}), 'Evidence rejected'); }
  if (d === 'certify') { t.disabled = true; act(() => api('affidavit_certify', {id}), 'Affidavit certified'); }
  if (d === 'ack') act(() => api('sos_ack', {id}), 'You are marked as responding');
  if (d === 'resolve') act(() => api('sos_resolve', {id}), 'Alert resolved');
  if (d === 'sos') raiseSos();
  if (d === 'retry-location') getCurrentLocation();
  if (d === 'sync-registration-roster') {
    const status = $('#registration-roster-status');
    t.disabled = true;
    t.textContent = 'Syncing…';
    if (status) status.textContent = 'Updating the private OneDrive workbook…';
    try {
      await api('registration_roster_sync', {});
      toast('Database workbook synced to OneDrive.');
      await load(true);
    } catch (error) {
      if (status) status.textContent = error.error || 'The workbook could not be synced. Your local accounts are unchanged; try again.';
      t.disabled = false;
      t.textContent = 'Sync database now';
    }
    return;
  }
});
async function downloadOperationalReport(link) {
  if (link.dataset.downloading === 'true') return;
  const from = $('#report-from')?.value || '', to = $('#report-to')?.value || '';
  const error = $('#operational-report-error');
  if (from && to && from > to) { error.textContent = 'The start date must be on or before the end date.'; return; }
  link.dataset.downloading = 'true'; reportDownloads++;
  link.setAttribute('aria-busy', 'true');
  if (error) error.textContent = `Preparing ${link.dataset.format.toUpperCase()} report…`;
  try {
    const response = await fetch(reportUrl(link.dataset.reportType, link.dataset.format), {credentials:'same-origin'});
    const type = response.headers.get('Content-Type') || '';
    if (!response.ok || type.includes('json') || type.includes('text/html') || type.includes('xml')) {
      let detail = '';
      if (type.includes('json')) {
        const payload = await response.json().catch(() => ({}));
        detail = payload.error || payload.message || '';
      }
      throw new Error(detail || `The report could not be created (HTTP ${response.status}).`);
    }
    const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1] || `smart-police-${link.dataset.reportType}.${link.dataset.format}`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (error) error.textContent = `${link.dataset.format.toUpperCase()} report downloaded.`;
  } catch (failure) { if (error) error.textContent = failure.message || 'The report could not be downloaded. Try again.'; }
  finally { link.removeAttribute('aria-busy'); delete link.dataset.downloading; reportDownloads = Math.max(0, reportDownloads - 1); }
}
app.addEventListener('submit', async e => {
  const form = e.target;
  if (form.id === 'backup-form') { e.preventDefault(); downloadBackup(form); return; }
  if (form.id === 'two-step-form') {
    e.preventDefault();
    if (form.dataset.submitting === 'true') return;
    const message = form.querySelector('.form-error'), button = form.querySelector('[type="submit"]');
    const passwordInput = form.querySelector('[name="password"]');
    let password = passwordInput?.value || '';
    const enabled = button.dataset.twoStepEnabled !== 'true';
    const needsPasskey = enabled && !S.me.has_passkey;
    message.textContent = '';
    if (!password) { message.textContent = 'Enter your current password to confirm this change.'; return; }
    if (!window.isSecureContext || !navigator.credentials?.get || (needsPasskey && !navigator.credentials?.create)) {
      passwordInput.value = '';
      password = '';
      message.textContent = 'Two-step verification needs a supported browser and secure HTTPS. Your device must also support passkey setup.';
      return;
    }
    form.dataset.dirty = 'true'; form.dataset.submitting = 'true'; button.disabled = true; button.textContent = needsPasskey ? 'Setting up verification…' : enabled ? 'Starting verification…' : 'Confirming change…';
    let createdPasskey = false;
    try {
      if (needsPasskey) {
        const {options:creationOptions} = await api('passkey_register_options', {password});
        const newCredential = await navigator.credentials.create({publicKey:webauthnCreateOptions(creationOptions)});
        if (!newCredential) throw new Error('The device did not create a passkey.');
        await api('passkey_register_verify', webauthnRegistrationJson(newCredential));
        S.me.has_passkey = true;
        createdPasskey = true;
      }
      button.textContent = enabled ? 'Confirm on your device…' : 'Confirming change…';
      const {options} = await api('passkey_two_step_options', {password, enabled});
      password = '';
      passwordInput.value = '';
      const credential = await navigator.credentials.get({publicKey:webauthnGetOptions(options)});
      if (!credential) throw new Error('The device did not verify the passkey.');
      const result = await api('passkey_two_step_verify', {...webauthnAssertionJson(credential), enabled});
      if (result.csrf) csrf = result.csrf;
      toast(result.message || (enabled ? 'Two-step verification enabled.' : 'Two-step verification disabled.'));
      await load(true);
    } catch (failure) {
      password = '';
      passwordInput.value = '';
      message.textContent = failure?.name === 'NotAllowedError'
        ? createdPasskey ? 'Passkey saved, but verification was cancelled. Two-step verification is still off; try again to finish setup.' : 'Device verification was cancelled. You can try again.'
        : (failure.error || failure.message || 'Could not change two-step verification. Try again.');
    } finally {
      passwordInput.value = '';
      form.dataset.submitting = 'false';
      if (app.contains(button)) { button.disabled = false; button.textContent = enabled ? 'Enable two-step verification' : 'Disable two-step verification'; }
    }
    return;
  }
  if (form.id === 'passkey-enroll-form') {
    e.preventDefault();
    if (form.dataset.submitting === 'true') return;
    const message = form.querySelector('.form-error'), button = form.querySelector('[type="submit"]');
    message.textContent = '';
    if (!window.isSecureContext || !navigator.credentials?.create) { form.querySelector('[name="password"]').value = ''; message.textContent = 'Passkeys need a supported browser and a secure HTTPS connection.'; return; }
    const values = Object.fromEntries(new FormData(form));
    if (!values.password) { message.textContent = 'Enter your current password to confirm this change.'; return; }
    form.dataset.submitting = 'true'; button.disabled = true; button.textContent = 'Starting device setup…';
    try {
      const {options} = await api('passkey_register_options', {password:values.password});
      values.password = '';
      const passwordInput = form.querySelector('[name="password"]');
      if (passwordInput) passwordInput.value = '';
      const credential = await navigator.credentials.create({publicKey:webauthnCreateOptions(options)});
      if (!credential) throw new Error('The device did not create a passkey.');
      await api('passkey_register_verify', webauthnRegistrationJson(credential));
      values.password = '';
      form.reset();
      toast('Device passkey saved.');
      await load(true);
    } catch (failure) {
      message.textContent = failure?.name === 'NotAllowedError' ? 'Passkey setup was cancelled. You can try again.' : (failure.error || failure.message || 'Could not set up this passkey.');
    } finally {
      values.password = '';
      const passwordInput = form.querySelector('[name="password"]');
      if (passwordInput) passwordInput.value = '';
      form.dataset.submitting = 'false';
      if (app.contains(button)) { button.disabled = false; button.textContent = S?.me?.has_passkey ? 'Replace device passkey' : 'Set up device passkey'; }
    }
    return;
  }
  if (form.matches('.user-reset-form')) {
    e.preventDefault();
    if (form.dataset.submitting === 'true') return;
    const values = Object.fromEntries(new FormData(form));
    const feedback = form.querySelector('.reset-feedback');
    const button = form.querySelector('.reset-fields [type="submit"]');
    feedback.textContent = '';
    let validation = passwordError(values.password);
    if (!validation && values.password !== values.confirm) validation = 'The passwords do not match.';
    if (!validation && values.confirmed !== 'yes') validation = 'Confirm that you intend to reset this account password.';
    if (validation) { feedback.textContent = validation; return; }
    form.dataset.submitting = 'true';
    button.disabled = true;
    button.textContent = 'Resetting…';
    feedback.textContent = 'Resetting this account password…';
    try {
      await api('user_password_reset', {id:+form.dataset.userReset, password:values.password});
      values.password = '';
      values.confirm = '';
      form.reset();
      form.querySelector('.reset-fields').hidden = true;
      form.querySelector('[data-reset-again]').hidden = false;
      feedback.textContent = 'Password reset successfully. The password entry has been cleared.';
    } catch (failure) {
      feedback.textContent = failure.error || 'Could not reset this password. Check your access and try again.';
    } finally {
      values.password = '';
      values.confirm = '';
      form.dataset.submitting = 'false';
      button.disabled = false;
      button.textContent = 'Reset password';
    }
    return;
  }
  if (form.id === 'password-form') {
    e.preventDefault();
    if (form.dataset.submitting === 'true') return;
    const values = Object.fromEntries(new FormData(form)), message = form.querySelector('.form-error'), button = form.querySelector('[type="submit"]');
    message.textContent = '';
    const validation = passwordError(values.new) || (values.new !== values.confirm ? 'The new passwords do not match.' : '');
    if (validation) { message.textContent = validation; return; }
    form.dataset.submitting = 'true'; button.disabled = true; button.textContent = 'Updating…';
    try { const result = await api('password_change', {old:values.old, new:values.new}); if (result.csrf) csrf = result.csrf; form.reset(); $('#password-dialog').close(); toast('Password changed.'); }
    catch (failure) { message.textContent = failure.error || 'Could not change the password. Check your current password and try again.'; }
    finally { form.dataset.submitting = 'false'; button.disabled = false; button.textContent = 'Update password'; }
    return;
  }
  const f = form.dataset.f;
  if (form.id === 'phone-otp-send' || form.id === 'phone-otp-verify') {
    e.preventDefault();
    if (form.dataset.submitting === 'true') return;
    const send = form.id === 'phone-otp-send';
    const button = form.querySelector('button[type=submit]');
    const message = form.querySelector('.form-error');
    form.dataset.submitting = 'true'; button.disabled = true; message.textContent = '';
    try {
      const result = await api(send ? 'phone_otp_send' : 'phone_otp_verify', send ? {} : Object.fromEntries(new FormData(form)));
      if (send) {
        alert(`Code sent\n\nDemo only — no SMS sent.\nNumber: ${result.phone}\nYour demo code: ${result.demo_code}\nExpires in 5 minutes.`);
        message.textContent = 'Demo code generated. Check the popup; wait 60 seconds before resending.';
      } else {
        form.reset(); message.textContent = result.message;
      }
    } catch (failure) { message.textContent = failure.error || 'Could not complete the OTP demonstration. Try again.'; }
    finally { form.dataset.submitting = 'false'; button.disabled = false; }
    return;
  }
  if (!f) return;
  e.preventDefault();
  const values = Object.fromEntries(new FormData(form)), message = form.querySelector('.form-error'), button = e.submitter || form.querySelector('[type="submit"],button:not([type])');
  if (f === 'request_review') values.decision = e.submitter?.value || '';
  if (message) message.textContent = '';
  let validation = '';
  if (f === 'admin_add') validation = !String(values.name||'').trim() ? 'Enter the Admin’s full name.' : usernameError(values.username) || adminEmailError(values.email);
  if (f === 'officer_add') {
    if (!String(values.name||'').trim()) validation = 'Enter the Officer’s full name.';
    else validation = usernameError(values.username);
    if (!validation && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email||''))) validation = 'Enter a valid Officer email address.';
  }
  if (f === 'officer_suspend' || f === 'user_suspend') {
    if (values.decision === 'suspend' && String(values.reason || '').trim().length < 10) validation = 'Enter a suspension reason of at least 10 characters.';
    else if (values.decision === 'suspend' && String(values.reason || '').length > 500) validation = 'The suspension reason must be 500 characters or fewer.';
    else if (!['suspend','reinstate'].includes(values.decision)) validation = 'Choose a valid account action.';
  }
  if (f === 'report') {
    if (values.title.trim().length < 3 || values.title.trim().length > 120) validation = 'Give your report a title between 3 and 120 characters.';
    else if (!incidentTypes.includes(values.type)) validation = 'Choose the incident type that best fits what happened.';
    else if (values.description.trim().length < 10 || values.description.length > 4000) validation = 'Describe what happened in 10–4,000 characters.';
  }
  if (f === 'request_create') validation = CitizenServices.validateRequest(form);
  if (f === 'face_photo_update' && values.face_consent !== 'yes') validation = 'Consent is required to save this camera photo.';
  if (f === 'request_review') validation = CitizenServices.validateReview(form, values);
  if (f === 'citizen_flag' && String(values.reason||'').trim().length < 10) validation = 'Enter an Admin review reason of at least 10 characters.';
  if (f === 'citizen_flag' && String(values.reason||'').trim().length > 500) validation = 'The Admin review reason must be 500 characters or fewer.';
  if (validation) { if (message) message.textContent = validation; form.querySelector(':invalid')?.focus(); return; }
  if (form.dataset.submitting === 'true') return;
  if (['officer_suspend','user_suspend'].includes(f) && values.decision === 'suspend' && !confirm('Suspend this account? The reason will be recorded, and the user will lose access immediately.')) return;
  form.dataset.submitting = 'true'; if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = 'Submitting…'; }
  const success = ['officer_suspend','user_suspend'].includes(f) ? (values.decision === 'suspend' ? 'Account suspended; reason recorded.' : 'Account reinstated.') : {report:'Report submitted', assign:'Case assigned to you', status:'Status updated', evidence_upload:'Evidence uploaded', affidavit_upload:'Affidavit submitted', admin_add:'Admin account invited',officer_add:'Officer account added',request_create:'Request submitted',request_claim:'Request claimed',request_review:'Review saved',citizen_flag:'Citizen account flagged for Admin review.',citizen_flag_clear:'Review flag cleared.',face_photo_update:'Camera photo saved securely'}[f];
  try {
    if (f === 'admin_add' || f === 'officer_add') { values.name=String(values.name||'').trim(); values.username=String(values.username||'').trim(); values.email=String(values.email||'').trim().toLowerCase(); }
    const result=await api(f, form.hasAttribute('data-file') ? new FormData(form) : values, form.hasAttribute('data-file'));
    if(f==='admin_add'||f==='officer_add')showStaffInvite(result);
    form.reset(); form.dataset.dirty = 'false'; form.dataset.submitting = 'false';
    if (f === 'report') tab = 'cases';
    if (f === 'request_create') tab = values.kind === 'affidavit' ? 'affidavits' : 'certifications';
    if (f === 'request_claim' || f === 'request_review' || f === 'citizen_flag') tab = 'requests';
    toast(success || 'Saved.');
    await load(true);
  } catch (failure) {
    if (message) message.textContent = failure.error || 'We could not save this yet. Your entries are still here; check your connection and try again.';
    form.dataset.submitting = 'false';
  } finally {
    if (button && app.contains(button)) { button.disabled = false; button.textContent = button.dataset.label || 'Submit'; }
  }
});

async function downloadBackup(form) {
  if (backupBusy) return;
  const values = Object.fromEntries(new FormData(form)), status = form.querySelector('[role="status"]'), button = form.querySelector('button');
  const accountPasswordValidation = passwordError(values.password);
  if (accountPasswordValidation) { status.textContent = accountPasswordValidation; return; }
  if (values.passphrase !== values.confirm) { status.textContent = 'Backup passphrases do not match.'; return; }
  const passphraseBytes = new TextEncoder().encode(values.passphrase).length;
  if (passphraseBytes < 16 || passphraseBytes > 1024) { status.textContent = 'The backup passphrase must be 16–1,024 UTF-8 bytes.'; return; }
  backupBusy = true; button.disabled = true; status.textContent = 'Creating and checking the encrypted backup. Keep this page open…';
  try {
    const response = await fetch('api.php?a=backup_archive', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF': csrf}, body: JSON.stringify(values)});
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Backup failed.'); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'smart-police.spbk';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    form.reset(); status.textContent = 'Encrypted backup sent to your downloads. Confirm the file is saved, then copy it to secure off-site storage and verify it using the recovery guide.';
  } catch (error) { status.textContent = error.message || 'Backup failed. Try again.'; }
  finally { values.password = values.passphrase = values.confirm = ''; backupBusy = false; button.disabled = false; }
}
function raiseSos() {
  if (!confirm('Send an SOS alert to available staff? This website does not contact emergency services.')) return;
  const mine=S?.sos?.find(s=>s.status==='Open'||s.status==='Responding');
  const send = async (lat, lng) => { try { const r = await api('sos', lat == null ? {} : {lat, lng}); toast(lat==null?'SOS sent. GPS location unavailable.':'SOS sent with your current location.'); track(r.id); await load(true); } catch (e) { toast(e.error || 'Could not send SOS'); } };
  if (!navigator.geolocation) return send();
  navigator.geolocation.getCurrentPosition(p => {
    if(mine)api('sos_update',{id:mine.id,lat:p.coords.latitude,lng:p.coords.longitude}).then(()=>{toast('Your location was updated.');load(true);}).catch(e=>toast(e.error||'Could not update location.'));
    else send(p.coords.latitude,p.coords.longitude);
  }, () => { if(mine)return toast('Could not update location. Check your browser location permission.'); toast('GPS unavailable. Sending the alert without a location.'); send(); }, {enableHighAccuracy: true, timeout: 10000, maximumAge: 0});
}
function getCurrentLocation(){
 const active=S?.sos?.find(s=>s.status==='Open'||s.status==='Responding');
 if(!active)return toast('Send an SOS before sharing a live location.');
 if(!navigator.geolocation)return toast('This browser does not support location sharing.');
 navigator.geolocation.getCurrentPosition(p=>api('sos_update',{id:active.id,lat:p.coords.latitude,lng:p.coords.longitude}).then(()=>{toast('Location updated.');load(true);}).catch(e=>toast(e.error||'Could not update location.')),()=>toast('Location unavailable. Check browser permissions and HTTPS.'),{enableHighAccuracy:true,timeout:10000,maximumAge:0});
}
function track(id) {
  if(!navigator.geolocation)return;
  if (sosWatch != null) navigator.geolocation.clearWatch(sosWatch); let last = 0;
  sosWatch = navigator.geolocation.watchPosition(p => { if (Date.now() - last < 8000) return; last = Date.now(); api('sos_update', {id, lat: p.coords.latitude, lng: p.coords.longitude}).catch(() => {}); }, () => toast('Location access is unavailable. Check your browser permission.'), {enableHighAccuracy: true});
}
function resumeLocationTracking(){
 if(S?.me?.role!=='citizen')return;
 const active=S.sos.find(s=>s.status==='Open'||s.status==='Responding');
 if(active&&!activeAlerts.has(active.id)){activeAlerts.add(active.id);track(active.id);}
 if(!active&&sosWatch!=null){navigator.geolocation?.clearWatch(sosWatch);sosWatch=null;}
}
function tickClock(){const el=$('#liveClock');if(el)el.textContent=new Intl.DateTimeFormat('en-ZA',{timeZone:'Africa/Johannesburg',dateStyle:'medium',timeStyle:'medium'}).format(new Date())+' SAST';}
function showHome(){
  document.body.classList.remove('workspace-theme');
  document.body.classList.add('home-glass');
  S=null;
  app.innerHTML=`<div class="site-shell"><header class="public-nav"><a class="brand" href="#home"><span class="brand-mark">SP</span><span>SMART<span class="brand-light">POLICE</span><small>COMMUNITY SAFETY PLATFORM</small></span></a><a class="nav-current" href="#home">Home</a><a href="#portal">Access portal</a><a class="nav-access" href="#portal">Secure access ↗</a></header><main class="landing-main"><section class="hero"><div class="hero-copy"><span class="eyebrow"><i></i> COMMUNITY SAFETY PLATFORM</span><h1>Safety starts with<br><span>being heard.</span></h1><p>A secure place to report an incident, keep track of a case, and share your location when you need help.</p><a class="hero-cta" href="#portal">Open access portal <span>→</span></a><div class="hero-caption"><span class="caption-dot"></span> A direct connection between citizens and their case team</div></div><div class="hero-bottom"><span>ONE SECURE PLACE TO</span><span>REPORT AN INCIDENT</span><b>·</b><span>SHARE YOUR LOCATION</span><b>·</b><span>FOLLOW CASE PROGRESS</span></div></section><section class="audience-section"><div class="section-heading"><span class="eyebrow">THOUGHTFULLY CONNECTED</span><h2>Support for every role.</h2><p>One shared platform. Three focused, role-based spaces.</p></div><div class="audience-grid"><a href="#portal" class="audience-card"><span>01 / CITIZENS</span><strong>Be heard.<br>Stay informed.</strong><small>Submit reports, share evidence, and check your case updates.</small><span class="card-link">Citizen portal ↗</span></a><a href="#portal" class="audience-card"><span>02 / OFFICERS</span><strong>Respond with<br>the full picture.</strong><small>Review the assigned case queue and respond to live SOS alerts.</small><span class="card-link">Officer portal ↗</span></a><a href="#portal" class="audience-card"><span>03 / ADMINISTRATORS</span><strong>Keep the work<br>in view.</strong><small>Manage access, review activity, and export record snapshots.</small><span class="card-link">Admin portal ↗</span></a></div></section><section class="trust-strip"><span class="trust-mark">SP</span><div><strong>Privacy-led by design.</strong><p>Sensitive files are encrypted at rest. Location is shared only through a user-initiated SOS alert.</p></div><a href="#portal">Explore secure access ↗</a></section><section class="safety-band"><span class="eyebrow">PLEASE NOTE</span><strong>This website does not replace emergency services.</strong><p>It does not connect to emergency dispatch. If you are in immediate danger, contact your local emergency number first.</p></section></main><footer class="public-footer"><span>SMART POLICE <small>COMMUNITY SAFETY PLATFORM</small></span><span>Location sharing requires browser permission and may require HTTPS.</span><span class="emergency-contact">Emergency: <a href="tel:10111">10111</a></span></footer></div>`;
  const roleHome = ['citizen','officer','admin'];
  document.querySelectorAll('.audience-card').forEach((card,index)=>card.href=`#portal/${roleHome[index]}/login`);
  const citizenAccess=$('.hero-cta'); if(citizenAccess)citizenAccess.href='#portal/citizen/login';
}
function routePortalHash() {
  const match=location.hash.match(/^#portal\/(citizen|officer|admin)\/(login|signup)$/);
  if(!match)return false;
  portalRole=firstRun?'admin':match[1];
  if(firstRun&&match[2]==='signup'){portalMode='signup';}
  else portalMode=match[2];
  return true;
}
window.addEventListener('hashchange',()=>{
  if(location.hash!=='#app')clearAdminInvite();
  if(window.AdminSetup?.isRoute()){
    if(csrfBootstrapped&&!window.AdminSetup.isActive())window.AdminSetup.start(api,!!S,refreshCsrf);
    return;
  }
  const leavingSetup=window.AdminSetup?.isActive();
  if(leavingSetup)window.AdminSetup.clear();
  if(S){if(location.hash!=='#app')location.hash='#app';if(leavingSetup)load(true);return;}
  if(location.hash==='#app'){if(!$('#lf'))login();return;}
  if(location.hash==='#portal'){portalMode='login';login();return;}
  if(routePortalHash()){login('',portalMode==='signup');return;}
  showHome();
});
(async () => {
  try {
    const r=await fetch('api.php?a=csrf',{credentials:'same-origin',cache:'no-store'}).then(response=>response.json());
    csrf=r.csrf||'';csrfBootstrapped=true;firstRun=!!r.setup;if(firstRun)portalRole='admin';
    if(window.AdminSetup?.isRoute())await window.AdminSetup.start(api,!!r.me,refreshCsrf);
    else if(r.me){csrf=r.csrf;location.hash='#app';await load(true);}
    else if(routePortalHash())login('',portalMode==='signup');
    else if(location.hash==='#portal')login();
    else showHome();
  } catch(e) {
    if(window.AdminSetup?.isRoute())window.AdminSetup.bootstrapError('Secure setup could not be initialized. Reload the page or ask an Admin to issue a fresh link.');
    else showHome();
  }
  setInterval(() => S && load(), 3000);setInterval(tickClock,1000);
})();
