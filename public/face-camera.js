'use strict';
(() => {
  let nextId = 0;
  const states = new Map();
  const activePanels = new Set();
  const errorText = {
    NotAllowedError: 'Camera permission was denied. Allow camera access in your browser settings, then try again.',
    PermissionDeniedError: 'Camera permission was denied. Allow camera access in your browser settings, then try again.',
    NotFoundError: 'No available camera was found on this device.',
    DevicesNotFoundError: 'No available camera was found on this device.',
    NotReadableError: 'The camera is already in use or could not be opened. Close other camera apps and try again.',
    TrackStartError: 'The camera could not be started. Close other camera apps and try again.',
    OverconstrainedError: 'A usable front-facing camera could not be selected on this device.',
    SecurityError: 'The browser blocked camera access. Open this site in a secure top-level browser tab.'
  };

  function isSecureEnough() {
    return window.isSecureContext || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  }
  function setError(state, message) {
    state.error.textContent = message;
  }
  function setStatus(state, message) {
    state.status.textContent = message;
  }
  function stopTracks(state) {
    const stream = state.stream;
    state.stream = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    state.video.pause();
    state.video.srcObject = null;
    state.video.hidden = true;
    state.panel.classList.remove('is-live');
    state.captureButton.disabled = true;
    state.stopButton.disabled = true;
    state.placeholder.hidden = !!state.photo.src;
    if (activePanels.has(state.panel)) activePanels.delete(state.panel);
  }
  function clearPhoto(state, notify = true) {
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoUrl = '';
    state.photo.removeAttribute('src');
    state.photo.hidden = true;
    state.placeholder.hidden = false;
    state.retakeButton.disabled = true;
    try {
      const transfer = new DataTransfer();
      state.fileInput.files = transfer.files;
    } catch (_) {
      state.fileInput.value = '';
    }
    if (notify) {
      state.fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      state.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function cleanupPanel(panel) {
    const state = states.get(panel);
    if (!state) return;
    state.generation++;
    stopTracks(state);
    clearPhoto(state, false);
    states.delete(panel);
  }
  function initPanel(panel) {
    if (states.has(panel)) return states.get(panel);
    const state = {
      panel,
      generation: 0,
      stream: null,
      photoUrl: '',
      video: panel.querySelector('video'),
      photo: panel.querySelector('[data-face-camera-photo]'),
      placeholder: panel.querySelector('[data-face-camera-placeholder]'),
      fileInput: panel.querySelector('input[name="selfie"]'),
      status: panel.querySelector('[data-face-camera-status]'),
      error: panel.querySelector('[data-face-camera-error]'),
      startButton: panel.querySelector('[data-face-camera="start"]'),
      captureButton: panel.querySelector('[data-face-camera="capture"]'),
      retakeButton: panel.querySelector('[data-face-camera="retake"]'),
      stopButton: panel.querySelector('[data-face-camera="stop"]')
    };
    if (![state.video,state.photo,state.placeholder,state.fileInput,state.status,state.error,state.startButton,state.captureButton,state.retakeButton,state.stopButton].every(Boolean)) return null;
    state.photo.hidden = true;
    state.video.hidden = true;
    state.captureButton.disabled = true;
    state.retakeButton.disabled = true;
    state.stopButton.disabled = true;
    states.set(panel, state);
    return state;
  }
  async function startCamera(panel) {
    const state = initPanel(panel);
    if (!state || state.stream) return;
    const generation = ++state.generation;
    const form = panel.closest('form');
    if (form) form.dataset.dirty = 'true';
    setError(state, '');
    if (!isSecureEnough()) {
      setError(state, 'Camera access requires HTTPS. Open the secure version of this site to continue.');
      setStatus(state, 'Camera has not started.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(state, 'This browser cannot access a live camera. Use a supported browser over HTTPS.');
      setStatus(state, 'Camera has not started.');
      return;
    }
    if (window.self !== window.top) {
      setStatus(state, 'Your browser may block camera access in an embedded page. The browser will ask for permission if available.');
    } else {
      setStatus(state, 'Waiting for your browser camera permission. Choose Allow to continue.');
    }
    state.startButton.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' } },
        audio: false
      });
      if (generation !== state.generation || !panel.isConnected || document.visibilityState === 'hidden') {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      state.stream = stream;
      activePanels.add(panel);
      state.video.srcObject = stream;
      state.video.hidden = false;
      state.placeholder.hidden = true;
      state.panel.classList.add('is-live');
      state.stopButton.disabled = false;
      await state.video.play();
      if (generation !== state.generation || !panel.isConnected || !state.stream) {
        stopTracks(state);
        return;
      }
      state.captureButton.disabled = false;
      setStatus(state, 'Live camera preview is active. Capture a photo when ready.');
    } catch (error) {
      if (generation !== state.generation) return;
      stopTracks(state);
      const message = errorText[error?.name] || 'The camera could not be started. Check browser permissions and try again.';
      setError(state, message);
      setStatus(state, 'Camera has not started.');
    } finally {
      if (generation === state.generation) state.startButton.disabled = false;
    }
  }
  async function capture(panel) {
    const state = initPanel(panel);
    if (!state?.stream || state.captureButton.disabled) return;
    const generation = state.generation;
    setError(state, '');
    const video = state.video;
    if (!video.videoWidth || !video.videoHeight) {
      setError(state, 'The live preview is not ready yet. Wait a moment and try again.');
      return;
    }
    const scale = Math.min(1, 1920 / video.videoWidth, 1920 / video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      setError(state, 'This browser could not prepare the photo. Please try again.');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || !panel.isConnected || !state.stream || generation !== state.generation) {
      setError(state, 'A photo could not be captured. Keep the camera open and try again.');
      return;
    }
    const file = new File([blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      state.fileInput.files = transfer.files;
    } catch (_) {
      setError(state, 'This browser cannot attach the captured photo to the form. Try a supported, up-to-date browser.');
      return;
    }
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photoUrl = URL.createObjectURL(blob);
    state.photo.src = state.photoUrl;
    state.photo.hidden = false;
    state.placeholder.hidden = true;
    state.fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    state.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    stopTracks(state);
    state.retakeButton.disabled = false;
    state.startButton.disabled = false;
    setStatus(state, 'Photo captured and ready to submit. Camera preview has stopped.');
  }
  function stop(panel) {
    const state = initPanel(panel);
    if (!state) return;
    state.generation++;
    stopTracks(state);
    state.startButton.disabled = false;
    setError(state, '');
    setStatus(state, state.photo.src ? 'Camera stopped. Your captured photo is preserved.' : 'Camera stopped.');
  }
  function retake(panel) {
    const state = initPanel(panel);
    if (!state) return;
    state.generation++;
    stopTracks(state);
    clearPhoto(state);
    setError(state, '');
    setStatus(state, 'Previous photo cleared. Start the camera to capture a new one.');
  }
  function markup() {
    const id = `face-camera-${++nextId}`;
    return `<section class="face-camera" data-face-camera-panel aria-labelledby="${id}-title">
      <input class="face-camera__file" id="${id}-file" name="selfie" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" required tabindex="-1" aria-label="Captured selfie for identity review">
      <header class="face-camera__heading">
        <span class="face-camera__eyebrow">LIVE CAMERA CAPTURE</span>
        <h3 id="${id}-title">Face recognition <span>(real-time camera review)</span></h3>
        <p>Use your front-facing camera to take a new photo. Existing files cannot be uploaded here.</p>
      </header>
      <div class="face-camera__viewport">
        <video class="face-camera__video" autoplay muted playsinline aria-label="Live camera preview" hidden></video>
        <img class="face-camera__photo" data-face-camera-photo alt="Captured photo preview" hidden>
        <p class="face-camera__placeholder" data-face-camera-placeholder>Camera preview and your captured photo will appear here.</p>
      </div>
      <div class="face-camera__controls" aria-label="Camera controls">
        <button type="button" data-face-camera="start">Start camera</button>
      <button type="button" data-face-camera="capture" disabled>Capture</button>
        <button type="button" data-face-camera="retake" disabled>Retake photo</button>
        <button type="button" data-face-camera="stop" disabled>Stop camera</button>
      </div>
      <p class="face-camera__status" data-face-camera-status role="status" aria-live="polite">Camera is off. Start it when you are ready.</p>
      <p class="face-camera__error" data-face-camera-error role="alert" aria-live="assertive"></p>
    </section>`;
  }
  function findPanel(target) {
    const panel = target?.closest?.('[data-face-camera-panel]');
    return panel && document.documentElement.contains(panel) ? panel : null;
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-face-camera]');
    if (!button) return;
    const panel = findPanel(button);
    if (!panel) return;
    const action = button.dataset.faceCamera;
    if (action === 'start') void startCamera(panel);
    else if (action === 'capture') void capture(panel);
    else if (action === 'retake') retake(panel);
    else if (action === 'stop') stop(panel);
  });
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.('[data-face-camera-panel]')) cleanupPanel(node);
        node.querySelectorAll?.('[data-face-camera-panel]').forEach(cleanupPanel);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') Array.from(states.keys()).forEach(stop);
  });
  window.addEventListener('pagehide', () => activePanels.forEach(panel => stop(panel)));
  window.addEventListener('beforeunload', () => activePanels.forEach(panel => stop(panel)));
  window.addEventListener('popstate', () => activePanels.forEach(panel => stop(panel)));
  window.addEventListener('hashchange', () => activePanels.forEach(panel => stop(panel)));
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    activePanels.forEach(panel => stop(panel));
    return originalPushState.apply(this, args);
  };
  ['face-camera:signout', 'session:ended', 'auth:logout'].forEach(name => {
    window.addEventListener(name, () => activePanels.forEach(panel => stop(panel)));
  });
  document.addEventListener('click', event => {
    const signOut = event.target.closest?.('#lo,[data-do="logout"],[data-do="signout"],[data-action="logout"],[data-action="signout"],[data-signout]');
    if (signOut) Array.from(states.keys()).forEach(stop);
  }, true);
  window.FaceCamera = {
    markup,
    cleanup() {
      Array.from(states.keys()).forEach(cleanupPanel);
      observer.disconnect();
    }
  };
})();
