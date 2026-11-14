'use strict';
(() => {
  function attach(passkeyButton) {
    if (!passkeyButton || document.getElementById('login-camera-open')) return;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'login-camera-open';
    trigger.className = 'auth-switch';
    trigger.textContent = 'Face Recognition';
    trigger.setAttribute('aria-haspopup', 'dialog');
    passkeyButton.replaceWith(trigger);
    const form = trigger.closest('form');
    const input = document.createElement('input');
    input.type = 'file'; input.name = 'login_capture'; input.hidden = true;
    input.accept = 'image/jpeg';
    form.append(input);
    form.querySelector('[name=username]')?.addEventListener('input', () => {
      input.value = ''; trigger.textContent = 'Face Recognition';
    });
    trigger.addEventListener('click', () => openCamera(trigger));
  }

  function openCamera(trigger) {
    if (document.getElementById('login-camera-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'login-camera-dialog';
    dialog.className = 'login-camera-dialog';
    dialog.setAttribute('aria-labelledby', 'login-camera-title');
    dialog.setAttribute('aria-describedby', 'login-camera-description');
    dialog.innerHTML = `
      <div class="login-camera-heading"><h2 id="login-camera-title">Live camera</h2><button type="button" data-login-camera="close" aria-label="Close live camera">Close</button></div>
      <p id="login-camera-description">Start your camera, then press Capture. A camera photo is required before password sign-in. This is not automated face detection or identity verification.</p>
      <div class="login-camera-viewport">
        <video autoplay muted playsinline hidden aria-label="Live camera preview"></video>
        <img hidden alt="Your captured sign-in photo" data-login-photo>
        <p data-camera-placeholder>Your camera is off.</p>
      </div>
      <p class="login-camera-status" role="status" aria-live="polite">Choose Start camera to allow camera access.</p>
      <p class="form-error" role="alert" data-camera-error></p>
      <div class="login-camera-actions"><button type="button" data-login-camera="start">Start camera</button><button type="button" data-login-camera="capture" disabled>Capture</button><button type="button" data-login-camera="stop" disabled>Stop camera</button></div>
      <small>The captured photo is sent securely with sign-in, checked as an image, and discarded. It is not saved or compared with your ID. Your password and any enabled passkey remain required.</small>
      <button type="button" class="auth-switch" data-login-camera="signin">Close and sign in</button>`;
    const app = document.getElementById('app');
    app.append(dialog);
    const video = dialog.querySelector('video');
    const placeholder = dialog.querySelector('[data-camera-placeholder]');
    const status = dialog.querySelector('[role=status]');
    const error = dialog.querySelector('[data-camera-error]');
    const start = dialog.querySelector('[data-login-camera=start]');
    const stop = dialog.querySelector('[data-login-camera=stop]');
    const capture = dialog.querySelector('[data-login-camera=capture]');
    const photo = dialog.querySelector('[data-login-photo]');
    let photoUrl = '';
    let stream = null;
    let generation = 0;
    let disposed = false;

    function stopCamera() {
      generation++;
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null;
      video.pause();
      video.srcObject = null;
      video.hidden = true;
      placeholder.hidden = !!photoUrl;
      capture.disabled = true;
      start.disabled = false;
      stop.disabled = true;
      start.textContent = 'Start camera';
      status.textContent = 'Camera stopped. You can start it again when ready.';
    }
    function cleanup() {
      if (disposed) return;
      disposed = true;
      stopCamera();
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      observer.disconnect();
      window.removeEventListener('hashchange', cleanup);
      window.removeEventListener('pagehide', cleanup);
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (dialog.open) dialog.close();
      dialog.remove();
    }
    function visibilityChanged() {
      if (document.hidden) stopCamera();
    }
    const observer = new MutationObserver(() => {
      if (!dialog.isConnected || !trigger.isConnected) cleanup();
    });
    observer.observe(app, {childList: true, subtree: true});
    window.addEventListener('hashchange', cleanup);
    window.addEventListener('pagehide', cleanup);
    document.addEventListener('visibilitychange', visibilityChanged);
    dialog.addEventListener('close', cleanup);
    dialog.addEventListener('cancel', cleanup);
    dialog.querySelectorAll('[data-login-camera=close], [data-login-camera=signin]').forEach(button => {
      button.addEventListener('click', () => {
        cleanup();
        document.querySelector('#lf [name=password]')?.focus();
      });
    });
    stop.addEventListener('click', stopCamera);
    capture.addEventListener('click', async () => {
      if (!stream || !video.videoWidth || !video.videoHeight) return;
      const attempt = generation;
      capture.disabled = true; error.textContent = '';
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(video.videoWidth,640);
        canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
        canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.85));
        if (disposed || attempt !== generation) return;
        if (!blob) throw new Error('Capture failed. Try again.');
        const input = trigger.closest('form')?.querySelector('[name=login_capture]');
        if (!input) throw new Error('Sign-in form closed. Try again.');
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob],'signin-camera.jpg',{type:'image/jpeg'}));
        input.files = transfer.files;
        if (photoUrl) URL.revokeObjectURL(photoUrl);
        photoUrl = URL.createObjectURL(blob); photo.src = photoUrl; photo.hidden = false;
        stopCamera(); placeholder.hidden = true;
        trigger.textContent = 'Face Recognition · Photo captured';
        status.textContent = 'Photo captured. Close this window to continue signing in.';
      } catch (failure) {
        error.textContent = failure.message || 'Could not capture your photo. Try again.';
        capture.disabled = !stream;
      }
    });
    start.addEventListener('click', async () => {
      error.textContent = '';
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        error.textContent = 'Camera access needs HTTPS and a browser with webcam support.';
        return;
      }
      const attempt = ++generation;
      photo.hidden = true;
      start.disabled = true;
      start.textContent = 'Opening camera…';
      stop.disabled = false;
      status.textContent = 'Allow camera access when your browser asks.';
      try {
        const opened = await navigator.mediaDevices.getUserMedia({
          video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}},
          audio: false
        });
        if (disposed || attempt !== generation || !dialog.isConnected) {
          opened.getTracks().forEach(track => track.stop());
          return;
        }
        stream = opened;
        video.srcObject = opened;
        video.hidden = false;
        placeholder.hidden = true;
        await video.play();
        if (disposed || attempt !== generation) return;
        capture.disabled = false;
        status.textContent = 'Camera is live. Your preview stays on this device.';
        start.textContent = 'Camera running';
        opened.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
          if (stream === opened && !disposed) stopCamera();
        }));
      } catch (failure) {
        if (disposed || attempt !== generation) return;
        stopCamera();
        const messages = {
          NotAllowedError: 'Camera permission was denied or blocked. Allow camera access in your browser site settings. If the embedded preview blocks access, open this website directly in your desktop browser, then try again.',
          SecurityError: 'Camera access was blocked by your browser. Check camera permissions for this site.',
          NotFoundError: 'No webcam was found. Connect a desktop webcam and try again.',
          NotReadableError: 'Your webcam may be in use. Close other camera apps and try again.',
          AbortError: 'The camera could not start. Try again.'
        };
        error.textContent = messages[failure.name] || 'The camera could not start. Check your webcam and browser permissions, then try again.';
      }
    });
    dialog.showModal();
    start.focus();
  }
  window.CitizenLoginCamera = {attach};
})();
