// Browser smoke checks against disposable storage. Requires Node 22+ and Chromium.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'sp-ui-test-'));
const children = [], pending = new Map(), exceptions = [];
const previewPdfFixture = execFileSync('php',['-r','require "src/pdf.php"; echo record_pdf("Uploaded document", array_fill(0,120,"This uploaded document contains readable test text on multiple pages."), "2026-11-03");']).toString('base64');
let serverOutput = '';
let socket, sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function launch(command, args, env = process.env) {
  const child = spawn(command, args, {env, detached: true, stdio: ['ignore', 'ignore', 'pipe']});
  if (command === 'php') child.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-12000); });
  else child.stderr.resume();
  children.push(child);
  child.on('error', error => console.error(`${command}: ${error.message}`));
  return child;
}
async function until(fn, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(message);
}
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitElement(selector) {
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `Missing ${selector}`);
}
async function click(selector) {
  await waitElement(selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function capture(name) {
  if (!process.env.UI_SNAPSHOTS_DIR) return;
  await mkdir(process.env.UI_SNAPSHOTS_DIR, {recursive:true});
  const {data} = await command('Page.captureScreenshot', {format:'jpeg',quality:75});
  await writeFile(join(process.env.UI_SNAPSHOTS_DIR, name + '.jpg'), Buffer.from(data,'base64'));
}
async function form(selector, values) {
  await waitElement(selector);
  return evaluate(`(async () => {
    const form = document.querySelector(${JSON.stringify(selector)}), values = ${JSON.stringify(values)};
    for (const [name, value] of Object.entries(values)) {
      const input = form.elements.namedItem(name);
      if (!input) throw new Error('Missing form field ' + name);
      if (input.type === 'checkbox') input.checked = value === true || value === 'yes';
      else input.value = value;
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
    }
    for (const input of form.querySelectorAll('input[type=password]')) {
      if (/confirm/i.test(input.name + input.id)) {
        input.value = values.confirm ?? values.new ?? values.password ?? '';
        input.dispatchEvent(new Event('input', {bubbles:true}));
      }
    }
    if(form.elements.namedItem('login_capture')&&!form.elements.namedItem('login_capture').files.length){
      document.querySelector('#login-camera-open').click();
      document.querySelector('[data-login-camera=start]').click();
      const waitFor=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Camera capture timed out');};
      await waitFor(()=>document.querySelector('#login-camera-dialog video')?.readyState>=2&&!document.querySelector('[data-login-camera=capture]').disabled);
      document.querySelector('[data-login-camera=capture]').click();
      await waitFor(()=>form.elements.namedItem('login_capture').files.length);
      document.querySelector('[data-login-camera=close]').click();
    }
    const valid = form.checkValidity(); if (valid) form.requestSubmit(); return valid;
  })()`);
}

try {
  const port = await freePort(), debugPort = await freePort();
  const origin = `http://localhost:${port}`;
  launch('php', ['-S', `127.0.0.1:${port}`, '-t', 'public'], {...process.env, SMART_POLICE_DATA: join(root, 'data'), SP_ONEDRIVE_ROSTER_SYNC: '0'});
  await until(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, 'PHP did not start');
  launch('chromium', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(root, 'browser')}`, 'about:blank']);
  let page;
  await until(async () => {
    try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p => p.type === 'page'); return !!page; }
    catch { return false; }
  }, 'Chromium did not start');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  };
  await command('Page.enable'); await command('Runtime.enable');
  await command('WebAuthn.enable', {enableUI:true});
  await command('WebAuthn.addVirtualAuthenticator', {options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,hasUserPresence:true,automaticPresenceSimulation:true}});
  await command('Page.navigate', {url: origin + '/#home'});
  await command('Page.bringToFront');
  await waitElement('.public-footer a[href="tel:10111"]');
  assert(await evaluate(`document.body.classList.contains('home-glass')&&!document.body.classList.contains('workspace-theme')&&/Emergency:\\s*10111/.test(document.querySelector('.public-footer').textContent)`),'Home must use its own glass theme and show Emergency: 10111');
  assert(await evaluate(`!document.querySelector('.hero-visual,.hero .glass-card,.hero .floating-chip')&&document.querySelector('.hero-copy')&&document.querySelector('.hero-cta')`),'Home must retain the introduction and portal link without the location, status or refresh boxes');
  assert(await evaluate(`(() => {const style=getComputedStyle(document.querySelector('.hero'));return style.display!=='grid'||style.gridTemplateColumns.trim().split(/\\s+/).length===1;})()`),'Home must not retain an empty right-hand hero column');
  await capture('home-liquid-glass');
  await evaluate(`document.querySelector('.public-footer').scrollIntoView({block:'end'})`);
  await capture('home-emergency-footer');
  await command('Emulation.setDeviceMetricsOverride',{width:402,height:874,deviceScaleFactor:1,mobile:true});
  await delay(180);
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'Home glass layout must fit a phone screen');
  await evaluate(`window.scrollTo(0,0)`);
  await capture('home-liquid-glass-mobile');
  await command('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.scrollTo(0,0)`);
  await command('Page.navigate', {url: origin + '/#portal'});
  await waitElement('#lf');
  assert(await evaluate(`!document.body.classList.contains('home-glass')`),'Home glass styling must not leak into the access portal');
  assert(await evaluate(`!document.querySelector('#username-help') && document.querySelector('#password-help').textContent==='Use 5–8 characters.'`));
  assert(await evaluate(`!document.querySelector('#name-help')`), 'The extra full-name helper text should be removed');
  await form('#lf', {name:'Browser Admin',username:'x'.repeat(81),email:'browser@admin.co.za',password:'Admin#26'});
  assert(await evaluate(`document.querySelector('#username-error').textContent.includes('80 characters') && !document.querySelector('#lf .err').textContent`));
  await form('#lf', {name:'Browser Admin',username:'browseradmin',email:'browser@example.com',password:'Admin#26'});
  assert(await evaluate(`document.querySelector('#admin-email-error').textContent.includes('@admin.co.za')`));
  await form('#lf', {name:'Browser Admin',username:'browseradmin',email:'browser@admin.co.za',password:'Admin#26',confirm:'Other5'});
  assert(await evaluate(`document.querySelector('#confirm-password-error').textContent==='Passwords do not match.' && document.querySelector('#pc').getAttribute('aria-invalid')==='true'`));
  await evaluate(`(() => {const password=document.querySelector('#p');password.value='Changed5';password.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert(await evaluate(`document.querySelector('#confirm-password-error').textContent==='Passwords do not match.'`));
  await evaluate(`(() => {const confirm=document.querySelector('#pc');confirm.value='Changed5';confirm.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert(await evaluate(`document.querySelector('#confirm-password-error').hidden && !document.querySelector('#pc').hasAttribute('aria-invalid')`));
  assert(await form('#lf', {name: 'Browser Admin', username: 'browseradmin', email:'browser@admin.co.za', password: 'Admin#26'}));
  await waitElement('[data-tab=dashboard]');
  assert(await evaluate(`document.querySelector('#admin-crime-chart')?.textContent.includes('No crimes recorded yet')&&!document.querySelector('#admin-crime-chart canvas')`),'An empty Crime stats chart must not show fabricated slices');
  assert(await evaluate(`document.body.textContent.includes('System alerts')&&document.body.textContent.includes('Recent portal activity')`), 'Admin dashboard is missing alerts or activity overview');
  assert(await evaluate(`!document.querySelector('[data-tab=sos]')`), 'Admin SOS Coordination tab should be hidden');
  assert(await evaluate(`document.body.classList.contains('workspace-theme') && getComputedStyle(document.querySelector('.app-shell')).color==='rgb(0, 0, 0)' && getComputedStyle(document.querySelector('.app-shell')).backgroundColor==='rgb(222, 222, 222)'`), 'Admin workspace must use ash-grey surfaces and black text');
  await capture('admin-ash-grey');
  await click('[data-tab=settings]');
  assert(await evaluate(`document.body.textContent.includes('Live synchronization')&&document.body.textContent.includes('Backup and recovery')&&document.body.textContent.includes('Saved PDF archive')`), 'Admin settings are missing sync or backup controls');
  assert(await evaluate(`(async()=>{const response=await fetch('api.php?a=settings_pdf');const bytes=new Uint8Array(await response.arrayBuffer());await load(true);return response.status===200&&response.headers.get('content-type')==='application/pdf'&&new TextDecoder().decode(bytes.slice(0,8)).startsWith('%PDF-1.4');})()`), 'Settings and sync PDF did not generate');
  await until(() => evaluate(`document.body.textContent.includes('smart-police-settings-sync-')`), 'Settings PDF was not saved to the PDF archive');
  await click('[data-tab=users]');
  assert(await evaluate(`(async()=>{await api('user_create',{name:'Browser Officer',username:'browserofficer',role:'officer',password:'Offic#26'});await load(true);return true;})()`));
  await until(() => evaluate(`document.querySelector('table')?.textContent.includes('browserofficer')`), 'Officer not saved');
  assert(await evaluate(`(() => {const f=document.querySelector('[data-f=admin_add]');return f.querySelector('h2').textContent==='Add Admins'&&f.querySelector('[type=submit]').textContent==='Add account'&&[...f.querySelectorAll('input')].map(i=>i.name).sort().join(',')==='email,name,username';})()`), 'Add Admins must have Full name, Username and Email inputs');
  await form('[data-f=admin_add]', {name:'Browser Director',username:'browserdirector',email:'director@example.com'});
  assert(await evaluate(`document.querySelector('[data-f=admin_add] .form-error').textContent.includes('@admin.co.za')`));
  await form('[data-f=admin_add]', {name:'Browser Director',username:'browserdirector',email:'director@admin.co.za'});
  await until(() => evaluate(`document.querySelector('#admin-setup-dialog')?.open`), 'Admin setup link was not displayed');
  const directorSetupUrl = await evaluate(`document.querySelector('#admin-setup-dialog').dataset.setupUrl`);
  assert(await evaluate(`(async()=>{await load(true);return document.querySelector('#admin-setup-dialog').open&&document.querySelector('#admin-setup-link-value').textContent.includes('#admin-setup/');})()`), 'Polling must not erase the one-time setup link');
  await click('[data-admin-invite-close]');
  assert(await evaluate(`!document.querySelector('#admin-setup-link-value')&&!document.querySelector('#admin-setup-dialog').dataset.setupUrl`), 'Closing must clear the private setup URL');
  await until(() => evaluate(`document.querySelector('table')?.textContent.includes('director@admin.co.za')`), 'Admin email not stored in account list');
  await form('[data-f=admin_add]', {name:'Browser Deputy',username:'browserdeputy',email:'deputy@admin.co.za'});
  await until(() => evaluate(`document.querySelector('#admin-setup-dialog')?.open`), 'Second Admin setup link was not displayed');
  await click('[data-admin-invite-close]');
  await until(() => evaluate(`document.querySelector('table')?.textContent.includes('deputy@admin.co.za')`), 'Second additional administrator was not saved');
  await click('[data-tab=reports]');
  await until(() => evaluate(`document.querySelectorAll('a[href*="operational_report"]').length === 10`), 'Five PDF/CSV report links not found');
  await evaluate(`(() => {
    document.querySelector('#report-from').value='2026-11-03';
    document.querySelector('#report-to').value='2026-01-01';
    document.querySelector('#report-to').dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await click('.report-download');
  assert(await evaluate(`document.querySelector('#operational-report-error').textContent.includes('start date')`));
  await evaluate(`(() => {
    for (const input of document.querySelectorAll('input[type=date]')) {
      input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  assert(await evaluate(`(async () => {
    for (const link of document.querySelectorAll('a[href*="operational_report"]')) {
      const response = await fetch(link.href); if (!response.ok) return false;
      if (!(await response.arrayBuffer()).byteLength) return false;
    } return true;
  })()`));
  await click('.report-download');
  try {
    await until(() => evaluate(`document.querySelector('#operational-report-error')?.textContent.includes('downloaded')`), 'Report link did not trigger download feedback');
  } catch(error) {
    await capture('admin-report-failure');
    throw new Error(`${error.message}: ${await evaluate(`JSON.stringify({feedback:document.querySelector('#operational-report-error')?.textContent,hash:location.hash,role:S?.me?.role})`)}; ${serverOutput.slice(-2000)}`);
  }
  // Password fields must be masked and confirmation required in an accessible dialog.
  await click('#pw'); await waitElement('dialog[open] form');
  assert(await evaluate(`document.querySelector('#new-password-help').textContent==='Use 5–8 characters.'`));
  assert(await form('dialog[open] form', {old: 'Admin#26', new: 'AdmNew26'}));
  await until(() => evaluate(`!document.querySelector('dialog[open]')`), 'Password change did not finish');
  await click('#lo'); await waitElement('#lf');
  await click('[data-role=admin]');
  assert(await form('#lf', {username: 'browseradmin', password: 'Wrong5'}));
  await until(() => evaluate(`!!document.querySelector('#lf .err')?.textContent`), 'Bad login missing inline error');
  assert(await evaluate(`document.querySelector('#lf [name=username]').value==='browseradmin' && document.querySelector('#p').value==='Wrong5'`));
  await click('#forgot-password-link');
  assert(await evaluate(`!document.querySelector('#forgot-password-help').hidden&&document.querySelector('#forgot-password-help').textContent.includes('Ask an administrator')`), 'Forgot password instructions were not shown');
  await click('[data-password-target=p]');
  assert.equal(await evaluate(`document.querySelector('#p').type`), 'text');
  await click('[data-password-target=p]');
  assert(await form('#lf', {username: 'browseradmin', password: 'AdmNew26'}));
  await waitElement('[data-tab=reports]');
  await click('#lo'); await waitElement('#lf');
  await click('[data-role=citizen]'); await click('#sw');
  await waitElement('#lf [name=name]');
  await waitElement('#lf [name=residential_address]');
  assert(await evaluate(`document.querySelector('#lf [name=email]').placeholder==='you@gmail.com'&&document.querySelector('#lf [name=phone]').pattern==='[1-9][0-9]{8}'&&!document.querySelector('#lf [name=create_passkey]')&&!document.querySelector('#lf').textContent.includes('Create a passkey now')`), 'Citizen contact fields must remain available without the signup passkey option');
  assert(await evaluate(`document.querySelector('.auth-card-heading p').textContent.includes('ready right after signup')&&document.querySelector('.app-nav')===null`), 'Citizen signup must clearly explain immediate account access');
  assert(await evaluate(`document.querySelector('#lf [name=selfie]')?.required&&document.querySelector('#lf [name=face_consent]')?.required&&document.querySelector('[data-face-camera=capture]')?.textContent.trim()==='Capture'`), 'Citizen signup must require consent and a captured camera photo');
  await click('[data-face-camera=start]');
  await until(() => evaluate(`document.querySelector('[data-face-camera=capture]')?.disabled===false`), 'Citizen signup camera did not start');
  await click('[data-face-camera=capture]');
  await until(() => evaluate(`document.querySelector('#lf [name=selfie]')?.files.length===1`), 'Citizen signup capture was not attached');
  await evaluate(`document.querySelector('#lf [name=face_consent]').checked=true`);
  assert(await form('#lf', {name: 'Browser Citizen', username: 'Citizen Name 🌍', residential_address: '1 Test Street, Cape Town', phone: '821234567', email: 'citizen@example.com', password: 'Citi#26', face_consent:'yes'}));
  await until(() => evaluate(`document.querySelector('#citizen-email-error')?.textContent.includes('@gmail.com')`), 'Citizen email domain restriction missing');
  assert(await form('#lf', {name: 'Browser Citizen', username: 'Citizen Name 🌍', residential_address: '1 Test Street, Cape Town', phone: '821234567', email: 'browsercitizen@gmail.com', password: 'Citi#26', face_consent:'yes'}));
  await until(() => evaluate(`!document.querySelector('#lf [name=name]')`), 'Citizen signup did not return to sign-in');
  await waitElement('#lf [name=username]');
  assert(await form('#lf', {username: 'Citizen Name 🌍', password: 'Citi#26'}));
  await until(() => evaluate(`S?.me?.role==='citizen'&&S.me.has_passkey===false&&S.me.has_face_photo===true`), 'Citizen photo must be stored with the account without setting up a passkey during signup');
  await waitElement('[data-tab=dashboard]');
  assert(await evaluate(`!document.querySelector('[data-tab=security]')`), 'Citizen navigation must not show Account security');
  // Internal security controls remain implemented but no longer have a public tab.
  await evaluate(`tabs.citizen.push('security')`);
  await evaluate(`tab='security';render()`);
  assert(await evaluate(`!document.querySelector('#passkey-device-label')&&!document.querySelector('#passkey-enroll-form')&&!document.body.textContent.includes('Set up device passkey')&&document.body.textContent.includes('Two-step verification')&&document.body.textContent.includes('Face ID')&&!!document.querySelector('#two-step-form')&&!!document.querySelector('form[data-f=face_photo_update]')`), 'Citizen security must offer two-step verification and account-photo update');
  assert(await evaluate(`S.me.has_passkey===false&&document.body.textContent.includes('Not enabled')`), 'A Citizen who skips a passkey during signup must still be able to enable two-step verification');
  assert(await form('#two-step-form', {password:'Wrong26'}));
  await until(() => evaluate(`document.querySelector('#two-step-form .form-error')?.textContent.includes('incorrect')`), 'Two-step changes must reject the wrong password');
  assert(await evaluate(`!S.me.two_step_enabled&&document.querySelector('#two-step-password').value===''`), 'A failed change must not enable two-step or retain the password');
  await evaluate(`window.testOriginalAssertion=webauthnAssertionJson;webauthnAssertionJson=credential=>({...window.testOriginalAssertion(credential),response:{...window.testOriginalAssertion(credential).response,signature:'AA'}});`);
  assert(await form('#two-step-form', {password:'Citi#26'}));
  await until(() => evaluate(`document.querySelector('#two-step-form .form-error')?.textContent.includes('not verified')`), 'Two-step changes must verify the passkey as well as the password');
  assert(await evaluate(`!S.me.two_step_enabled&&S.me.has_passkey===true`), 'A failed second verification must not turn on two-step');
  await evaluate(`webauthnAssertionJson=window.testOriginalAssertion;delete window.testOriginalAssertion;`);
  assert(await form('#two-step-form', {password:'Citi#26'}));
  await until(() => evaluate(`S?.me.two_step_enabled===true`), 'Two-step enabling did not complete');
  assert(await evaluate(`!document.querySelector('#passkey-enroll-form')&&!document.querySelector('#passkey-device-label')`), 'Two-step setup must not expose separate passkey controls');
  assert(await evaluate(`(async()=>{const r=await fetch('api.php?a=passkey_register_options',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF':csrf},body:JSON.stringify({password:'Citi#26'})});return r.status===409})()`), 'Server must block replacing a protected passkey');
  await capture('citizen-two-step-enabled');
  await click('#lo'); await waitElement('#lf');
  assert(await evaluate(`document.querySelector('#login-camera-open')?.textContent==='Face Recognition'&&!document.querySelector('#passkey-login')&&!document.body.textContent.includes('Use saved passkey')`), 'Citizen sign-in must show Face Recognition instead of a standalone saved-passkey button');
  await click('#login-camera-open');
  await waitElement('#login-camera-dialog[open]');
  assert(await evaluate(`!document.querySelector('#login-camera-dialog video').srcObject&&document.querySelector('#login-camera-dialog').textContent.includes('not automated face detection')&&document.querySelector('[data-login-camera=capture]').disabled`), 'Camera must require permission and explain capture is not identity verification');
  await evaluate(`window.loginCameraGet=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Permission denied','NotAllowedError'));`);
  await click('[data-login-camera=start]');
  await until(() => evaluate(`document.querySelector('[data-camera-error]')?.textContent.includes('denied')`), 'Sign-in camera permission errors must offer retry guidance');
  await evaluate(`navigator.mediaDevices.getUserMedia=window.loginCameraGet`);
  await click('[data-login-camera=start]');
  await until(() => evaluate(`document.querySelector('#login-camera-dialog video')?.readyState>=2&&document.querySelector('#login-camera-dialog video').srcObject?.active`), 'Desktop login camera must show a real live video stream');
  await evaluate(`window.loginCameraStream=document.querySelector('#login-camera-dialog video').srcObject`);
  await capture('citizen-signin-live-camera');
  await command('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert(await evaluate(`document.querySelector('#login-camera-dialog').getBoundingClientRect().width<=innerWidth`), 'Camera dialog must fit narrow screens');
  await capture('citizen-signin-live-camera-phone');
  await command('Emulation.clearDeviceMetricsOverride');
  await click('[data-login-camera=stop]');
  assert(await evaluate(`window.loginCameraStream.getTracks().every(track=>track.readyState==='ended')`), 'Stop camera must release the webcam');
  await click('[data-login-camera=start]');
  await until(() => evaluate(`document.querySelector('#login-camera-dialog video')?.srcObject?.active`), 'Login camera must restart after stopping');
  await evaluate(`window.loginCameraStream=document.querySelector('#login-camera-dialog video').srcObject;document.querySelector('#login-camera-dialog').close();`);
  await until(() => evaluate(`!document.querySelector('#login-camera-dialog')&&window.loginCameraStream.getTracks().every(track=>track.readyState==='ended')`), 'Closing the dialog must release the webcam');
  await click('#login-camera-open');
  await evaluate(`navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.resolveLoginCamera=resolve)`);
  await click('[data-login-camera=start]');
  await click('[data-login-camera=close]');
  await evaluate(`(async()=>{window.lateLoginCamera=await window.loginCameraGet({video:true,audio:false});window.resolveLoginCamera(window.lateLoginCamera);navigator.mediaDevices.getUserMedia=window.loginCameraGet;})()`);
  await until(() => evaluate(`window.lateLoginCamera.getTracks().every(track=>track.readyState==='ended')`), 'A late permission result must not leave the webcam running after closing');
  await click('#login-camera-open');
  await click('[data-login-camera=start]');
  await until(() => evaluate(`document.querySelector('#login-camera-dialog video')?.srcObject?.active`), 'Camera must work after a cancelled permission request');
  await evaluate(`window.loginCameraStream=document.querySelector('#login-camera-dialog video').srcObject;location.hash='#portal/officer/login'`);
  await until(() => evaluate(`!document.querySelector('#login-camera-dialog')&&window.loginCameraStream.getTracks().every(track=>track.readyState==='ended')&&!document.querySelector('#login-camera-open')`), 'Changing portals must stop the Citizen camera and hide its control');
  await evaluate(`location.hash='#portal/citizen/login'`);
  await waitElement('#login-camera-open');
  assert(await evaluate(`(async()=>{const response=await fetch('api.php?a=state');return S===null&&response.status===401})()`), 'A camera preview must never create an authenticated session');
  await evaluate(`document.querySelector('#u').value='Citizen Name 🌍'`);
  assert(await evaluate(`(async()=>{const response=await fetch('api.php?a=passkey_login_options',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF':csrf},body:JSON.stringify({username:'Citizen Name 🌍'})});const result=await response.json();return !response.ok&&result.error.includes('password first');})()`), 'Direct passkey requests must not bypass password-first two-step verification');
  assert(await evaluate(`S===null`), 'Passkey alone must not open a protected account');
  assert(await form('#lf', {username:'Citizen Name 🌍',password:'Citi#26'}));
  await until(() => evaluate(`!!document.querySelector('#two-step-verify')&&!document.querySelector('#two-step-verify').hidden`), 'Correct password must show the second step');
  assert(await evaluate(`S===null&&document.querySelector('#p').value===''`), 'Password step must not open a session or retain the password');
  assert(await evaluate(`(async()=>{const r=await fetch('api.php?a=state');return r.status===401})()`), 'Protected API must remain inaccessible after password only');
  await capture('citizen-two-step-sign-in');
  await evaluate(`window.testGet=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=()=>Promise.reject(new DOMException('Cancelled','NotAllowedError'));`);
  await click('#two-step-verify');
  await until(() => evaluate(`document.querySelector('#lf .err')?.textContent.includes('cancelled')`), 'Cancelled device verification must remain retryable');
  assert(await evaluate(`S===null&&!document.querySelector('#two-step-verify').disabled`), 'Cancellation must not sign in or disable retry');
  await evaluate(`navigator.credentials.get=window.testGet;delete window.testGet;window.testLastAssertion=null;window.testOriginalAssertion=webauthnAssertionJson;webauthnAssertionJson=credential=>(window.testLastAssertion=window.testOriginalAssertion(credential));`);
  await click('#two-step-verify');
  await waitElement('[data-tab=dashboard]');
  assert(await evaluate(`S.me.two_step_enabled===true&&S.me.has_passkey===true`), 'Both factors must complete sign-in');
  assert(await evaluate(`(async()=>{const r=await fetch('api.php?a=passkey_login_verify',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF':csrf},body:JSON.stringify(window.testLastAssertion)});return r.status===400})()`), 'Successful login assertion must not be replayable');
  await evaluate(`webauthnAssertionJson=window.testOriginalAssertion;delete window.testOriginalAssertion;delete window.testLastAssertion;`);
  await evaluate(`tab='security';render()`);
  assert(await form('#two-step-form', {password:'Citi#26'}));
  await until(() => evaluate(`S?.me.two_step_enabled===false&&S.me.has_passkey===true&&!!document.querySelector('#two-step-form')&&!document.querySelector('#passkey-enroll-form')`), 'Two-step verification must be switchable off without a separate passkey setup control');
  await click('[data-tab=dashboard]');
  assert(await evaluate(`!!document.querySelector('.citizen-sos-button') && !document.querySelector('[data-tab=sos]') && !document.querySelector('.app-nav [data-tab=cases]') && !!document.querySelector('.citizen-stats') && S.citizenStats.total_submissions===0`), 'Citizen needs dashboard SOS/statistics without SOS Coordination or Cases navigation tabs');
  assert(await evaluate(`(() => {
    const colours={total_cases:'rgb(212, 212, 212)',open_cases:'rgb(252, 231, 243)',approved_requests:'rgb(216, 180, 254)',active_sos:'rgb(254, 226, 226)'};
    if(!Object.entries(colours).every(([key,value])=>{const card=document.querySelector('.citizen-stat[data-stat="'+key+'"]');return card&&getComputedStyle(card).backgroundColor===value&&getComputedStyle(card.querySelector('span')).color==='rgb(0, 0, 0)';}))return false;
    const service=document.querySelector('.citizen-stat[data-stat="service_requests"]'),gradient=service&&getComputedStyle(service).backgroundImage,button=document.querySelector('.citizen-sos-button');
    return gradient&&gradient.includes('gradient')&&getComputedStyle(button).backgroundColor==='rgb(239, 68, 68)'&&!document.querySelector('.app-disclaimer')&&!document.body.textContent.includes('For security, sessions expire after 30 minutes');
  })()`), 'Citizen cards must use the requested grey/pink/glass-blue/purple/light-red palette, SOS must be red and footer disclaimer removed');
  await capture('citizen-dashboard-colours');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+2`), 'Citizen dashboard overflows a phone viewport');
  await capture('citizen-dashboard-phone');
  await command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  assert(await evaluate(`!!document.querySelector('#citizen-map-content iframe') && document.querySelector('#citizen-map-content').textContent.includes('OVERVIEW')`), 'Dashboard must display a labelled overview while GPS permission is unavailable');
  await evaluate(`CitizenServices.syncDashboard(false);window.testLocationStarts=0;window.testGeo={watch:navigator.geolocation.watchPosition,clear:navigator.geolocation.clearWatch};navigator.geolocation.watchPosition=(success)=>{window.testGeoSuccess=success;const id=9000+(++window.testLocationStarts);setTimeout(()=>success({coords:{latitude:-33.9,longitude:18.4,accuracy:12},timestamp:Date.now()}),10);return id;};navigator.geolocation.clearWatch=id=>{window.testClearedWatch=id;};`);
  await click('.app-nav [data-tab=dashboard]');
  await until(() => evaluate(`document.querySelector('#citizen-map-content')?.textContent.includes('-33.90000')`), 'Dashboard location map did not show the permitted GPS fix');
  assert(await evaluate(`S.sos.length===0 && window.testLocationStarts===1 && document.querySelector('#citizen-map-content').textContent.includes('12 m') && document.querySelector('#citizen-map-content iframe').src.includes('marker=')`), 'Dashboard must automatically start one GPS watch without creating an SOS');
  await evaluate(`window.testGeoSuccess({coords:{latitude:-33.91,longitude:18.41,accuracy:8},timestamp:Date.now()})`);
  await until(() => evaluate(`document.querySelector('#citizen-map-content')?.textContent.includes('-33.91000')`), 'Map did not follow a later GPS update');
  await evaluate(`load(true)`);
  assert(await evaluate(`window.testLocationStarts===1 && document.querySelector('#citizen-map-content').textContent.includes('-33.91000')`), 'Polling must preserve one active GPS watch and its current point');
  await delay(1800);
  await capture('citizen-live-location-map');
  await click('[data-do=citizen-location-stop]');
  assert(await evaluate(`window.testClearedWatch===9001 && !!document.querySelector('#citizen-map-content iframe') && !document.querySelector('#citizen-map-content iframe').src.includes('marker=')`), 'Pausing must clear the live point/watch but preserve the overview map');
  await evaluate(`load(true)`);
  assert(await evaluate(`window.testLocationStarts===1 && document.querySelector('#citizen-map-content').textContent.includes('paused')`), 'A paused map must not restart during polling');
  await click('[data-do=citizen-location]');
  await until(() => evaluate(`window.testLocationStarts===2 && document.querySelector('#citizen-map-content').textContent.includes('-33.90000')`), 'Resume must start a new live watch');
  await evaluate(`tab='security';render()`);
  assert(await evaluate(`window.testClearedWatch===9002 && !document.querySelector('#citizen-map-content')`), 'Leaving the Dashboard must clear its GPS watch');
  await evaluate(`window.testGeoSuccess({coords:{latitude:-30,longitude:20,accuracy:5},timestamp:Date.now()})`);
  await click('.app-nav [data-tab=dashboard]');
  await until(() => evaluate(`window.testLocationStarts===3 && document.querySelector('#citizen-map-content').textContent.includes('-33.90000')`), 'A later Dashboard visit must start automatically without showing a stale point');
  await evaluate(`CitizenServices.syncDashboard(false);window.testDeniedStarts=0;navigator.geolocation.watchPosition=(_success,error)=>{window.testDeniedStarts++;error({code:1});return 9010;}`);
  await click('.app-nav [data-tab=dashboard]');
  assert(await evaluate(`window.testDeniedStarts===1 && document.querySelector('#sos-location-error').textContent.includes('denied') && !document.querySelector('#citizen-map-content iframe').src.includes('marker=')`), 'Denied GPS must keep an honest overview and show recovery guidance');
  await evaluate(`load(true)`);
  assert(await evaluate(`window.testDeniedStarts===1 && S.sos.length===0`), 'Denied GPS must not repeatedly prompt or create SOS alerts');
  await evaluate(`navigator.geolocation.watchPosition=window.testGeo.watch;navigator.geolocation.clearWatch=window.testGeo.clear;delete window.testGeo;`);
  const setServiceFiles = async () => {
    assert(await evaluate(`document.body.classList.contains('workspace-theme') && getComputedStyle(document.querySelector('.app-shell')).color==='rgb(0, 0, 0)'`), 'Citizen workspace must use black text in the ash-grey theme');
    assert(await evaluate(`(()=>{const style=getComputedStyle(document.querySelector('.service-form [name=id_number]'));return style.color==='rgb(0, 0, 0)' && style.backgroundColor==='rgb(244, 244, 244)';})()`), 'Citizen form controls must have black text on light-grey backgrounds, not legacy dark fields');
    await evaluate(`(() => {const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const pdf=Uint8Array.from(atob(${JSON.stringify(previewPdfFixture)}),c=>c.charCodeAt(0));for(const input of document.querySelectorAll('.service-form input[type=file]:not([name=selfie])')){const transfer=new DataTransfer();transfer.items.add(new File([input.name==='original'?pdf:bytes],input.name+(input.name==='original'?'.pdf':'.png'),{type:input.name==='original'?'application/pdf':'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await click('[data-face-camera=start]');
    await until(() => evaluate(`document.querySelector('[data-face-camera-panel] video')?.readyState>=2 && !document.querySelector('[data-face-camera=capture]').disabled`), 'Live camera preview did not start');
    await evaluate(`window.testCameraStream=document.querySelector('[data-face-camera-panel] video').srcObject`);
    await click('[data-face-camera=capture]');
    await until(() => evaluate(`document.querySelector('[name=selfie]').files.length===1 && !document.querySelector('[data-face-camera-photo]').hidden`), 'Live photo capture was not attached to the request');
    assert(await evaluate(`document.querySelector('[name=selfie]').files[0].type==='image/jpeg' && window.testCameraStream.getTracks().every(track=>track.readyState==='ended')`), 'Camera must stop after attaching a real captured JPEG');
  };
  await click('[data-tab=affidavits]');
  assert(await evaluate(`document.body.textContent.includes('Face recognition') && !document.body.textContent.includes('Admin provides oversight and download access, but cannot approve or reject requests')`), 'Citizen camera label or removed review text is wrong');
  await evaluate(`window.testOriginalMedia=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Test denied camera','NotAllowedError'));`);
  await click('[data-face-camera=start]');
  await until(() => evaluate(`document.querySelector('[data-face-camera-error]').textContent.includes('denied')`), 'Camera permission denial did not show a useful error');
  assert(await evaluate(`!document.querySelector('[data-face-camera-open-link]') && !document.body.textContent.includes('Open this site in a new tab')`), 'Removed new-tab link must not return after a camera error');
  await evaluate(`navigator.mediaDevices.getUserMedia=window.testOriginalMedia;delete window.testOriginalMedia;`);
  await setServiceFiles();
  await click('[data-face-camera=retake]');
  assert(await evaluate(`document.querySelector('[name=selfie]').files.length===0`), 'Retake must clear the previous capture');
  await setServiceFiles();
  assert(await evaluate(`(() => {const box=document.querySelector('.face-camera__viewport').getBoundingClientRect();return box.width<=320 && box.height<=242 && !document.body.textContent.includes('The captured photo is submitted for human identity review.');})()`), 'Camera preview must be compact and the requested explanatory text removed');
  await evaluate(`document.querySelector('[data-face-camera-panel]').scrollIntoView({block:'center',behavior:'instant'})`);
  await capture('citizen-live-camera-capture');
  assert.equal(await form('.service-form',{id_number:'TEST-ID-UI',race:'Self-described test',reason:'A test request for an affidavit record.',statement:'This is the complete test affidavit statement for Officer review.'}), false);
  await evaluate(`document.querySelector('.service-form').requestSubmit()`);
  assert(await evaluate(`document.querySelector('.service-form .form-error').textContent.includes('Consent') && document.querySelector('[name=id_proof]').files.length===1`), 'Request validation must require consent and preserve selected uploads');
  assert(await form('.service-form',{consent:'yes'}));
  await until(() => evaluate(`S.requests.length===1 && document.body.textContent.includes('Submission receipt PDF')`), 'Affidavit request did not save with a receipt');
  await click('[data-tab=certifications]');
  assert(await evaluate(`!document.querySelector('.service-form [name=reason],.service-form [name=id_proof]') && document.querySelector('label[for=service-copy]').textContent==='Copy of document' && [...document.querySelector('[name=document_type]').options].map(o=>o.value).join('|')==='|Identity document|Matric|Qualification|Others'`), 'Certification must have the document type dropdown and copy label, without reason or separate ID proof fields');
  await setServiceFiles();
  assert.equal(await form('.service-form',{id_number:'TEST-ID-UI',consent:'yes'}),false);
  assert(await form('.service-form',{id_number:'TEST-ID-UI',document_type:'Matric',consent:'yes'}));
  await until(() => evaluate(`S.requests.length===2`), 'Certification original/copy request did not save');
  assert(await evaluate(`S.requests.find(r=>r.kind==='certification').details.document_type==='Matric' && document.querySelector('.service-list-block').textContent.includes('Matric')`), 'Selected document type must persist in Citizen submission details');
  await evaluate(`document.querySelector('.service-form').scrollIntoView({block:'start',behavior:'instant'})`);
  await capture('citizen-certification-form');
  assert(await evaluate(`(async()=>{const response=await fetch(document.querySelector('.service-downloads a').href);return response.ok&&(await response.text()).startsWith('%PDF-');})()`), 'Citizen receipt PDF cannot be downloaded');
  // Additional requests let Admin exercise both decisions without removing the Officer path.
  for (const serviceTab of ['affidavits','certifications']) {
    await click(`[data-tab=${serviceTab}]`);
    await setServiceFiles();
    const serviceValues={id_number:'ADMIN-REVIEW-UI',consent:'yes'};
    if(serviceTab==='affidavits') {
      serviceValues.reason='This request will exercise administrator review.';
      serviceValues.statement='A full statement for administrator identity and document review.';
    } else serviceValues.document_type='Qualification';
    assert(await form('.service-form',serviceValues));
    const count=serviceTab==='affidavits'?3:4;
    await until(() => evaluate(`S.requests.length===${count}`), 'Additional Admin review request did not save');
  }
  await click('[data-face-camera=start]');
  await until(() => evaluate(`document.querySelector('[data-face-camera-panel] video')?.srcObject?.active`), 'Camera could not restart for cleanup check');
  await evaluate(`window.testCameraStream=document.querySelector('[data-face-camera-panel] video').srcObject`);
  await click('#lo'); await waitElement('#lf');
  assert(await evaluate(`window.testCameraStream.getTracks().every(track=>track.readyState==='ended')`), 'Signing out must release an active camera');
  await evaluate(`location.hash='#portal/admin/login'`);
  await until(() => evaluate(`document.querySelector('[data-role=admin]')?.getAttribute('aria-pressed')==='true'`), 'Admin login route missing');
  await form('#lf', {username:'browseradmin',password:'AdmNew26'});
  await waitElement('[data-tab=requests]');
  await click('[data-tab=requests]');
  assert(await evaluate(`document.body.textContent.includes('Document type: Matric') && document.body.textContent.includes('Document type: Qualification')`), 'Admin must see the submitted certification document types');
  assert(await evaluate(`document.body.textContent.includes('TEST-ID-UI') && !!document.querySelector('form[data-f=request_review]') && !document.querySelector('form[data-f=request_claim]')`), 'Admin must view request documents and have approval/rejection controls without claiming');
  let adminDecisions=0;
  for (const decision of ['approve','reject']) {
    await evaluate(`(() => {const review=document.querySelector('form[data-f=request_review]');review.closest('details').open=true;review.querySelector('[name=note]').value='Administrator reviewed the submitted identity and documents.';review.querySelector('[name=identity_checked]').checked=true;review.querySelector('[name=documents_checked]').checked=true;review.requestSubmit(review.querySelector('[value=${decision}]'));})()`);
    adminDecisions++;
    await until(() => evaluate(`S.requests.filter(r=>r.reviewer_role==='admin').length===${adminDecisions}`), 'Admin decision did not save with reviewer attribution');
  }
  assert(await evaluate(`!!document.querySelector('a[href*="pdf=result"]')`), 'Admin approval must save a downloadable reviewed PDF');
  await waitElement('[data-tab=users]'); await click('[data-tab=users]');
  assert(await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('Citizen Name 🌍'));return row?.cells[0].textContent.includes('1 Test Street, Cape Town')&&row?.cells[3].textContent.includes('browsercitizen@gmail.com')&&!row?.querySelector('[data-approval=approve]')})()`), 'Manage users did not show the active Citizen details');
  await click('#lo'); await waitElement('#lf');
  await evaluate(`location.hash='#portal/citizen/login'`);
  await until(() => evaluate(`document.querySelector('[data-role=citizen]')?.getAttribute('aria-pressed')==='true'`), 'Citizen login route missing');
  assert(await form('#lf', {username: 'Citizen Name 🌍', password: 'Citi#26'}));
  await waitElement('[data-tab=report]'); await click('[data-tab=report]');
  await form('[data-f=report]', {title: 'Browser case', description: 'bad', type: 'Theft'});
  assert(await evaluate(`!!document.querySelector('[data-f=report] .form-error')?.textContent`));
  assert(await evaluate(`document.querySelector('[data-f=report] [name=title]').value === 'Browser case'`));
  assert(await form('[data-f=report]', {title: 'Browser case', description: 'A real isolated browser test report.', type: 'Theft', location: 'Test location'}));
  await waitElement('.case');
  assert(await evaluate(`document.querySelector('.case').textContent.includes('Browser case')`));
  assert(await evaluate(`!!document.querySelector('form[data-f=evidence_upload]') && !!document.querySelector('form[data-f=affidavit_upload]')`), 'Existing Citizen evidence/affidavit actions must remain available');
  await click('[data-tab=dashboard]');
  assert(await evaluate(`document.querySelector('.citizen-submissions').textContent.includes('Browser case') && S.citizenStats.total_submissions===5`), 'Dashboard submissions must include crime reports and service requests');
  await capture('citizen-dashboard-desktop');
  assert(await evaluate(`(async () => {
    const original=window.fetch;
    try { window.fetch=async ()=>{throw new Error('Test network interruption');}; await load(true); }
    finally {window.fetch=original;}
    const retry=document.querySelector('#retry-state');
    if(!retry)return false;
    retry.click();
    return true;
  })()`), 'Connection failure did not show a retry action');
  await until(() => evaluate(`!document.querySelector('#connection-banner')`), 'Connection banner did not clear');
  await evaluate(`(() => {const originalConfirm=window.confirm,originalGeo=navigator.geolocation.getCurrentPosition;window.confirm=()=>true;navigator.geolocation.getCurrentPosition=(_,failure)=>failure();try{document.querySelector('.citizen-sos-button').click();}finally{window.confirm=originalConfirm;navigator.geolocation.getCurrentPosition=originalGeo;}})()`);
  await until(() => evaluate(`S.sos.some(s=>s.status==='Open')`), 'Citizen dashboard emergency button did not send an SOS when GPS was unavailable');
  assert(await evaluate(`!document.querySelector('[data-tab=sos]') && S.citizenStats.active_sos===1`), 'SOS must work from the dashboard without restoring the removed Citizen tab');
  await evaluate(`(() => {const alert=S.sos.find(s=>s.status==='Open');alert.status='Responding';alert.ack_by=1;render();})()`);
  assert(await evaluate(`(() => {const station=document.querySelector('.citizen-response-station');return !!station&&station.textContent.includes('Pretoria Central Station')&&station.textContent.includes('not the Officer’s live GPS location')&&station.querySelector('a')?.href==='https://www.openstreetmap.org/search?query=Pretoria%20Central%20Station';})()`), 'A Citizen must see the responding station and map link after an Officer accepts an SOS');
  await evaluate(`load(true)`);
  await until(() => evaluate(`S.sos.some(s=>s.status==='Open')`), 'Citizen SOS test state was not restored');
  // Backend conflict responses must not clear the authenticated frontend state.
  assert(await evaluate(`(async()=>{try{await api('sos_update',{id:999999,lat:0,lng:0});}catch{}return !!S?.me;})()`));
  // A real conflict must not re-route the citizen to sign-in.
  assert.equal(await evaluate(`!!document.querySelector('#lf')`), false);
  await click('#lo'); await waitElement('#lf');
  await evaluate(`location.hash='#portal/officer/signup'`);
  await waitElement('#lf [name=name]');
  assert(await evaluate(`document.querySelector('[data-role=officer]').getAttribute('aria-pressed')==='true'`));
  await form('#lf', {name:'Applicant Officer',username:'requestedofficer',password:'four'});
  assert(await evaluate(`document.querySelector('#password-error').textContent.includes('5–8')`));
  await form('#lf', {name:'Applicant Officer',username:'requestedofficer',password:'123456789'});
  assert(await evaluate(`document.querySelector('#password-error').textContent.includes('5–8')`));
  await form('#lf', {name:'Applicant Officer',username:'requestedofficer',password:'000000',confirm:'000000'});
  assert(await evaluate(`document.querySelector('#password-error').textContent.includes('Weak Password')`), 'Signup must reject all-zero passwords even when the length is valid');
  await form('#lf', {name:'Applicant Officer',username:'requestedofficer',password:'Staff'});
  await until(() => evaluate(`!document.querySelector('#lf [name=name]')`), 'Officer signup did not complete');
  await form('#lf', {username:'requestedofficer',password:'Staff'});
  await until(() => evaluate(`document.querySelector('#lf .err')?.textContent.includes('approval')`), 'Pending officer was not blocked');
  await evaluate(`location.hash='#portal/admin/signup'`);
  await waitElement('#lf [name=name]');
  await form('#lf', {name:'Applicant Admin',username:'requestedadmin',email:'applicant@admin.co.za',password:'AdminReq'});
  await until(() => evaluate(`!document.querySelector('#lf [name=name]')`), 'Admin signup did not complete');
  await form('#lf', {username:'requestedadmin',password:'AdminReq'});
  await until(() => evaluate(`document.querySelector('#lf .err')?.textContent.includes('approval')`), 'Pending admin was not blocked');
  // Signup already redirected to this role's login URL; reuse the form after denial.
  await form('#lf', {username:'browseradmin',password:'AdmNew26'});
  await waitElement('[data-tab=users]'); await click('[data-tab=users]');
  const rowAction = async (username, decision) => evaluate(`(() => {
    const row=[...document.querySelectorAll('tbody tr')].find(row=>[...row.querySelectorAll('td')].some(td=>td.textContent===${JSON.stringify(username)}));
    if(!row)throw new Error('Missing applicant');
    row.querySelector('[data-approval=${decision}]').click();
  })()`);
  await rowAction('requestedofficer','approve');
  await until(() => evaluate(`!document.querySelector('button[data-approval=approve][disabled]') && [...document.querySelectorAll('tbody tr')].some(row=>row.textContent.includes('requestedofficer') && row.textContent.includes('Active'))`), 'Officer approval did not save');
  await rowAction('requestedadmin','reject');
  await until(() => evaluate(`[...document.querySelectorAll('tbody tr')].some(row=>row.textContent.includes('requestedadmin') && row.textContent.includes('Rejected'))`), 'Admin rejection did not save');
  assert(await evaluate(`document.querySelector('.section-heading h1').textContent==='Manage users'`));
  await evaluate(`(() => {
    const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent==='requestedofficer');
    const form=row.querySelector('[data-f=officer_suspend]');
    form.querySelector('[name=reason]').value='Policy review requires temporary suspension.';
    const original=window.confirm;window.confirm=()=>true;
    try{form.requestSubmit();}finally{window.confirm=original;}
  })()`);
  await until(() => evaluate(`[...document.querySelectorAll('tbody tr')].some(row=>row.cells[1]?.textContent==='requestedofficer'&&row.textContent.includes('Suspended')&&row.textContent.includes('Policy review requires temporary suspension.'))`), 'Officer suspension reason was not saved in Manage users');
  await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent==='requestedofficer');row.querySelector('[data-f=officer_suspend]').requestSubmit();})()`);
  await until(() => evaluate(`[...document.querySelectorAll('tbody tr')].some(row=>row.cells[1]?.textContent==='requestedofficer'&&!row.querySelector('.officer-suspension-summary'))`), 'Officer reinstatement did not save');
  assert(await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent===S.me.username);return row&&!row.querySelector('[data-f=user_suspend], [data-f=officer_suspend]');})()`), 'Admins must not be offered self-suspension');
  for (const username of ['Citizen Name 🌍','browserdirector']) {
    assert(await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent===${JSON.stringify(username)}),form=row?.querySelector('[data-f=user_suspend]');if(!form)return false;form.closest('details').open=true;form.requestSubmit();return true;})()`), 'Citizen and added Admin suspension controls must exist');
    assert(await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent===${JSON.stringify(username)});return row.querySelector('[data-f=user_suspend] .form-error')?.textContent.includes('reason');})()`), 'A suspension reason must be required');
    await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent===${JSON.stringify(username)}),form=row.querySelector('[data-f=user_suspend]');form.querySelector('[name=reason]').value='Temporary account suspension for policy review.';const confirm=window.confirm;window.confirm=()=>true;try{form.requestSubmit();}finally{window.confirm=confirm;}})()`);
    await until(() => evaluate(`[...document.querySelectorAll('tbody tr')].some(row=>row.cells[1]?.textContent===${JSON.stringify(username)}&&row.textContent.includes('Suspended')&&row.textContent.includes('Temporary account suspension for policy review.'))`), 'Suspension and reason must be saved for each role');
    if (username === 'Citizen Name 🌍') await capture('admin-manage-suspensions');
    await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.cells[1]?.textContent===${JSON.stringify(username)});row.querySelector('[data-f=user_suspend]').requestSubmit();})()`);
    await until(() => evaluate(`[...document.querySelectorAll('tbody tr')].some(row=>row.cells[1]?.textContent===${JSON.stringify(username)}&&!row.querySelector('.officer-suspension-summary'))`), 'Each role must be reinstatable');
  }
  const officerResetForm = await evaluate(`(() => {const row=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('requestedofficer'));return row?.querySelector('form[data-user-reset]')?.getAttribute('data-user-reset')||''})()`);
  assert(officerResetForm, 'Officer password reset form missing');
  const officerResetSelector = `form[data-user-reset="${officerResetForm}"]`;
  await click('.user-reset summary');
  await form(officerResetSelector, {password:'Reset5',confirm:'Other5',confirmed:'yes'});
  assert(await evaluate(`document.querySelector('${officerResetSelector} .reset-feedback').textContent.includes('match')`));
  await form(officerResetSelector, {password:'Reset5',confirm:'Reset5',confirmed:'yes'});
  await until(() => evaluate(`document.querySelector('${officerResetSelector} .reset-feedback')?.textContent.includes('successfully')`), 'Admin password reset did not finish');
  assert(await evaluate(`document.querySelector('${officerResetSelector} .reset-fields').hidden && document.querySelector('${officerResetSelector} [name=password]').value===''`));
  await click('#lo'); await waitElement('#lf');
  await evaluate(`location.hash='#portal/officer/login'`);
  await until(() => evaluate(`document.querySelector('[data-role=officer]')?.getAttribute('aria-pressed')==='true'`), 'Officer login route missing');
  await form('#lf', {username:'requestedofficer',password:'Reset5'});
  try { await waitElement('[data-tab=mine]'); } catch (error) {
    const state = await evaluate(`JSON.stringify({hash:location.hash,error:document.querySelector('#lf .err')?.textContent,heading:document.querySelector('#lf h2')?.textContent,nav:document.querySelector('.app-nav')?.textContent})`);
    throw new Error(`${error.message}; browser state: ${state}`);
  }
  assert(await evaluate(`S.me.role==='officer'`));
  assert(await evaluate(`!caseCard(S.cases[0]).includes('case-pdf-link')`), 'Officer case cards must not show the timestamped case-PDF link');
  await click('[data-tab=requests]');
  await evaluate(`document.querySelector('form[data-f=request_claim]').requestSubmit()`);
  await waitElement('form[data-f=request_review]');
  await click('.service-review summary');
  const viewCameraSelector = '[data-document-viewer-url*="file_id="][data-document-viewer-name$=".jpg"]';
  await evaluate(`window.testOfficerReview=Number(document.querySelector('form[data-f=request_review] [name=id]').value)`);
  await click('.app-nav [data-tab=dashboard]');
  assert(await evaluate(`!!document.querySelector('.officer-kpis') && !!document.querySelector('.officer-sos-area') && !document.querySelector('.app-nav [data-tab=sos]') && getComputedStyle(document.querySelector('.app-main h1')).color==='rgb(0, 0, 0)'`), 'Officer needs a black-text Dashboard with SOS controls, without a separate SOS tab');
  assert(await evaluate(`!document.querySelector('.officer-station-location')&&!document.querySelector('.app-main').textContent.includes('Pretoria Police Station')`), 'Officer Dashboard must not show the station card or map link');
  await capture('officer-dashboard-ash-grey');
  assert(await evaluate(`!!document.querySelector('.officer-sos-area [data-do=ack]')`), 'Open SOS alerts must have a respond action on the Dashboard');
  await evaluate(`window.testRespondedSos=Number(document.querySelector('.officer-sos-area [data-do=ack]').dataset.id)`);
  await click('.officer-sos-area [data-do=ack]');
  await until(() => evaluate(`S.sos.find(item=>Number(item.id)===window.testRespondedSos)?.status==='Responding'`), 'Officer Dashboard did not mark the SOS as responding');
  await click('.officer-sos-area [data-do=resolve]');
  await until(() => evaluate(`S.sos.find(item=>Number(item.id)===window.testRespondedSos)?.status==='Resolved'`), 'Officer Dashboard did not resolve the SOS');
  await click('.app-nav [data-tab=requests]');
  await evaluate(`[...document.querySelectorAll('form[data-f=request_review]')].find(form=>Number(form.querySelector('[name=id]').value)===window.testOfficerReview).closest('details').open=true`);
  await click(viewCameraSelector);
  await until(() => evaluate(`document.querySelector('.document-viewer[open] img')?.naturalWidth>0`), 'Officer camera image did not render in the portal');
  assert(await evaluate(`document.querySelector('.document-viewer__download').href.includes('a=request_download') && !new URL(document.querySelector('.document-viewer__download').href).searchParams.has('preview')`), 'Viewer download must retain the authenticated original download endpoint');
  await evaluate(`window.testDocumentBlob=document.querySelector('.document-viewer img').src;load(true)`);
  assert(await evaluate(`!!document.querySelector('.document-viewer[open] img')`), 'Live refresh must not close the active document viewer');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert(await evaluate(`(() => {const box=document.querySelector('.document-viewer').getBoundingClientRect();return box.width<=innerWidth && box.height<=innerHeight;})()`), 'Document viewer must fit a phone viewport');
  await capture('officer-document-image-mobile');
  await click('.document-viewer__close');
  assert(await evaluate(`!document.querySelector('.document-viewer[open]') && !document.querySelector('.document-viewer img, .document-viewer canvas')`), 'Closing the viewer must remove private preview elements');
  await command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await click('[data-document-viewer-name="original.pdf"]');
  try {
    await until(() => evaluate(`!!document.querySelector('.document-viewer[open] canvas') && document.querySelector('.document-viewer__pdf-stage')?.getAttribute('aria-busy')!=='true'`), 'Uploaded PDF did not render inside the portal');
  } catch(error) {
    await capture('officer-document-pdf-failure');
    throw new Error(`${error.message}: ${await evaluate(`document.querySelector('.document-viewer')?.textContent`)}; ${serverOutput.slice(-2200)}`);
  }
  assert(await evaluate(`(() => {const canvas=document.querySelector('.document-viewer canvas');const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;return !document.querySelector('.document-viewer iframe') && canvas.width>100 && pixels.some((value,index)=>index%4!==3 && value<100);})()`), 'PDF rendering must contain actual document content, not an empty canvas or native iframe');
  await click('[data-pdf-action=next]');
  await until(() => evaluate(`document.querySelector('.document-viewer__pdf-page-count').textContent.startsWith('Page 2 ') && document.querySelector('.document-viewer__pdf-stage').getAttribute('aria-busy')!=='true'`), 'PDF next-page control did not render page two');
  await click('[data-pdf-action=previous]');
  await until(() => evaluate(`document.querySelector('.document-viewer__pdf-page-count').textContent.startsWith('Page 1 ') && document.querySelector('.document-viewer__pdf-stage').getAttribute('aria-busy')!=='true'`), 'PDF previous-page control did not return to page one');
  await evaluate(`window.testPdfWidth=document.querySelector('.document-viewer canvas').width`);
  await click('[data-pdf-action=zoom-in]');
  await until(() => evaluate(`document.querySelector('.document-viewer canvas')?.width>window.testPdfWidth && document.querySelector('.document-viewer__pdf-stage').getAttribute('aria-busy')!=='true'`), 'PDF zoom control did not redraw the page');
  await click('[data-pdf-action=fit]');
  await until(() => evaluate(`document.querySelector('.document-viewer canvas')?.width===window.testPdfWidth && document.querySelector('.document-viewer__pdf-stage').getAttribute('aria-busy')!=='true'`), 'PDF fit-width control did not reset zoom');
  await capture('officer-document-pdf');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(() => evaluate(`!document.querySelector('.document-viewer[open]')`), 'Escape did not close the document viewer');
  await evaluate(`window.testOriginalFetch=window.fetch;window.fetch=async (url,options)=>String(url).includes('preview=1')?new Response(JSON.stringify({error:'Missing document'}),{status:404,headers:{'Content-Type':'application/json'}}):window.testOriginalFetch(url,options);`);
  await click(viewCameraSelector);
  await until(() => evaluate(`document.querySelector('.document-viewer [role=alert]')?.textContent.includes('not be found')`), 'Failed previews need an explicit inline error');
  await evaluate(`window.fetch=window.testOriginalFetch;delete window.testOriginalFetch;`);
  await click('.document-viewer__close');
  await evaluate(`window.testOriginalFetch=window.fetch;window.testPreviewAborted=false;window.fetch=(url,options)=>String(url).includes('preview=1')?new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{window.testPreviewAborted=true;reject(new DOMException('Aborted','AbortError'));})):window.testOriginalFetch(url,options);`);
  await click(viewCameraSelector);
  await click('.document-viewer__close');
  assert(await evaluate(`window.testPreviewAborted`), 'Closing a loading preview must abort the request');
  await evaluate(`window.fetch=window.testOriginalFetch;delete window.testOriginalFetch;`);
  await evaluate(`const review=document.querySelector('form[data-f=request_review]');review.querySelector('[name=note]').value='Identity and submitted documents manually checked.';review.querySelector('[value=approve]').click();`);
  assert(await evaluate(`document.querySelector('form[data-f=request_review] .form-error').textContent.includes('both')`), 'Officer approval must require identity and document checks');
  await evaluate(`(() => {const review=document.querySelector('form[data-f=request_review]');review.querySelector('[name=identity_checked]').checked=true;review.querySelector('[name=documents_checked]').checked=true;review.querySelector('[value=approve]').click();})()`);
  await until(() => evaluate(`S.requests.some(r=>r.status==='Approved') && !!document.querySelector('a[href*="pdf=result"]')`), 'Officer approval did not create a downloadable review PDF');
  await evaluate(`document.querySelector('form[data-f=request_claim]').requestSubmit()`);
  await waitElement('form[data-f=request_review]');
  await click('.service-review summary');
  await evaluate(`(() => {const review=document.querySelector('form[data-f=request_review]');review.querySelector('[name=note]').value='Please upload a clearer ID photo and resubmit.';review.querySelector('[value=reject]').click();})()`);
  await until(() => evaluate(`S.requests.some(r=>r.status==='Rejected')`), 'Officer rejection did not save its reason');
  await click('[data-document-viewer-url*="pdf=result"]');
  await until(() => evaluate(`!!document.querySelector('.document-viewer[open] canvas') && document.querySelector('.document-viewer__pdf-stage')?.getAttribute('aria-busy')!=='true'`), 'Reviewed PDFs must also render inside the portal');
  await evaluate(`document.querySelector('#lo').click()`);
  await waitElement('#lf');
  assert(await evaluate(`!document.querySelector('.document-viewer[open]') && !document.querySelector('.document-viewer canvas')`), 'Signing out must clear the document preview');
  await evaluate(`location.hash='#portal/citizen/login'`);
  await until(() => evaluate(`document.querySelector('[data-role=citizen]')?.getAttribute('aria-pressed')==='true'`), 'Citizen login route missing');
  await form('#lf',{username:'Citizen Name 🌍',password:'Citi#26'});
  await until(() => evaluate(`S?.me?.role==='citizen' && !!document.querySelector('.app-nav')`), 'Citizen could not return to approved documents');
  await click('.app-nav [data-tab=certifications]');
  await until(() => evaluate(`!!document.querySelector('[data-approved-pdf]')`), 'Citizen has no approved certification download');
  assert(await evaluate(`document.querySelector('[data-approved-pdf]').textContent==='Download stamped document copy PDF'`), 'Citizen must have a clearly labelled stamped-copy PDF download');
  assert(await evaluate(`(async()=>{const response=await fetch(document.querySelector('[data-approved-pdf]').href,{credentials:'same-origin',cache:'no-store'});return response.ok && response.headers.get('content-type').startsWith('application/pdf') && response.headers.get('content-disposition').startsWith('attachment;') && new TextDecoder().decode((await response.arrayBuffer()).slice(0,5))==='%PDF-';})()`), 'Citizen approved-PDF download did not return an authenticated PDF attachment');
  await capture('citizen-approved-documents-ash-grey');
  assert(await evaluate(`caseCard(S.cases[0]).includes('case-pdf-link')`),'Citizen case-PDF links must remain available');
  await evaluate(`(async()=>{for(const type of ['Theft','Assault','Fraud','Vandalism'])await api('report',{title:'Chart fixture '+type,type,description:'Recorded incident fixture for live crime type statistics.',location:'Test area'});})()`);
  const priorSetupUser = await evaluate(`(async()=> (await api('csrf')).me.username)()`);
  await command('Page.navigate',{url:directorSetupUrl});
  await waitElement('#admin-setup-complete');
  assert(await evaluate(`location.hash==='#admin-setup'`), 'Setup token must be removed from the address bar');
  await form('#admin-setup-complete',{password:'Admin2x',confirm:'Wrong'});
  assert(await evaluate(`document.querySelector('#admin-setup-complete .form-error').textContent.toLowerCase().includes('match')`), 'Setup confirmation must match the password');
  await form('#admin-setup-complete',{password:'Admin2x',confirm:'Admin2x'});
  await waitElement('.setup-success');
  assert.equal(await evaluate(`(async()=> (await api('csrf')).me.username)()`),priorSetupUser,'Password setup must not switch the existing identity');
  await capture('admin-password-setup-success');
  await click('[data-setup-login]');
  await waitElement('#lf');
  assert(await evaluate(`(() => {const a=document.querySelector('.portal-auth-modes a.selected'),b=document.querySelector('.portal-auth-modes a:not(.selected)');return a.textContent==='Sign in'&&getComputedStyle(a).backgroundColor!==getComputedStyle(b).backgroundColor&&getComputedStyle(a).color==='rgb(0, 0, 0)';})()`), 'Selected Sign in must have a distinct grey background');
  await click('.portal-auth-modes a:not(.selected)');
  await until(() => evaluate(`document.querySelector('.portal-auth-modes a.selected')?.textContent==='Sign up'`),'Sign up did not become selected');
  assert(await evaluate(`getComputedStyle(document.querySelector('.portal-auth-modes a.selected')).backgroundColor!==getComputedStyle(document.querySelector('.portal-auth-modes a:not(.selected)')).backgroundColor`),'Selected Sign up must have a distinct grey background');
  await capture('admin-auth-selected-signup');
  await click('.portal-auth-modes a:not(.selected)');
  await form('#lf',{username:'browserdirector',password:'Admin2x'});
  await waitElement('#admin-users-chart canvas');
  assert(await evaluate(`!document.body.textContent.includes('Items awaiting review')&&document.body.textContent.includes('Crime stats')&&document.querySelector('#admin-cases-status')&&document.querySelector('#admin-crime-chart canvas')`),'Admin Dashboard must show Crime stats instead of the review graph');
  assert(await evaluate(`(() => {const bar=document.querySelector('#admin-cases-status .bar i'),label=document.querySelector('#admin-cases-status .admin-status-item>span'),background=bar&&getComputedStyle(bar).backgroundImage;return background&&background.includes('rgb(37, 99, 235)')&&background.includes('rgb(147, 51, 234)')&&getComputedStyle(label).color==='rgb(0, 0, 0)';})()`),'Cases by status bars must be blue/purple with black labels');
  assert.deepEqual(await evaluate(`(() => {const chart=echarts.getInstanceByDom(document.querySelector('#admin-users-chart'));return [0,1,2].map(i=>chart.getVisual({seriesIndex:0,dataIndex:i},'color'));})()`),['#ec4899','#facc15','#a855f7'],'User role columns must use pink, yellow and purple');
  assert(await evaluate(`(() => {const chart=echarts.getInstanceByDom(document.querySelector('#admin-crime-chart')),series=chart.getOption().series;return series.length===1&&series[0].type==='pie'&&!Array.isArray(series[0].radius)&&series[0].data.length===3&&series[0].data.reduce((n,item)=>n+item.value,0)===S.stats.totalCases&&series[0].data.some(item=>item.name==='Remaining types');})()`),'Crime pie must count every case and disclose grouping');
  assert.deepEqual(await evaluate(`(() => {const chart=echarts.getInstanceByDom(document.querySelector('#admin-crime-chart'));return [0,1,2].map(i=>chart.getVisual({seriesIndex:0,dataIndex:i},'color'));})()`),['#ec4899','#facc15','#a855f7'],'Crime pie must use pink, yellow and purple');
  await click('[data-tab=cases]');
  assert(await evaluate(`!!document.querySelector('.case')&&!document.querySelector('.case-pdf-link')`),'Admin case cards must not show the timestamped case-PDF link');
  await click('[data-tab=dashboard]');
  assert(await evaluate(`(() => {const box=document.querySelector('.admin-activity-panel');return box&&getComputedStyle(box).gridColumn.includes('1 / -1')&&box.scrollWidth<=box.clientWidth+1;})()`), 'Recent activity must be full width without clipped text');
  await command('Emulation.setDeviceMetricsOverride',{width:1024,height:1400,deviceScaleFactor:1,mobile:false});
  await delay(180);
  await capture('admin-live-statistics-graphs');
  await command('Emulation.setDeviceMetricsOverride',{width:402,height:874,deviceScaleFactor:1,mobile:true});
  await delay(180);
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.admin-activity-panel').scrollWidth<=document.querySelector('.admin-activity-panel').clientWidth+1`),'Admin graphs and activity must fit a narrow phone screen');
  await capture('admin-statistics-mobile');
  await command('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
  await click('[data-tab=users]');
  await capture('admin-add-admins-two-fields');
  assert.deepEqual(exceptions, [], 'Browser raised an uncaught exception');
  console.log('PASS: role portals, Citizen services/camera, Officer/Admin decisions, private image/PDF previews with pages/zoom, viewer errors/abort/signout cleanup, preserved case actions and passkeys; no uncaught JS errors');
} finally {
  socket?.close();
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  await delay(300);
  await rm(root, {recursive: true, force: true});
}
