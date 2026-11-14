(() => {
  "use strict";

  const MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "text/plain"]);
  const MAX_PDF_BYTES = 50 * 1024 * 1024;
  const MAX_PDF_PAGES = 2000;
  const PDF_CANVAS_PIXEL_BUDGET = 14_000_000;
  const PDF_MAX_CANVAS_EDGE = 8192;
  let dialog;
  let titleElement;
  let bodyElement;
  let statusElement;
  let downloadElement;
  let activeController = null;
  let activeObjectUrl = null;
  let activeTrigger = null;
  let requestSequence = 0;
  let sessionObserver = null;
  let sessionCheckTimer = 0;
  let pdfjsModulePromise = null;
  let activePdfLoadingTask = null;
  let activePdfDocument = null;
  let activePdfRenderTask = null;
  let activePdfResizeObserver = null;
  let activePdfStage = null;
  let activePdfCanvas = null;
  let activePdfPageLabel = null;
  let activePdfPreviousButton = null;
  let activePdfNextButton = null;
  let activePdfPageNumber = 1;
  let activePdfPageCount = 0;
  let activePdfZoom = 1;
  let activePdfRenderVersion = 0;
  let activePdfLastStageWidth = 0;

  const appRoot = () => document.getElementById("app");

  function safeFilename(value) {
    const name = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
    return name.slice(0, 240) || "Document";
  }

  function validatedUrls(rawUrl) {
    let previewUrl;
    try {
      previewUrl = new URL(rawUrl, window.location.href);
    } catch {
      throw new Error("This document link is not valid.");
    }

    const apiPath = new URL("api.php", window.location.href).pathname;
    if (
      previewUrl.origin !== window.location.origin ||
      previewUrl.pathname !== apiPath ||
      previewUrl.username ||
      previewUrl.password ||
      previewUrl.hash
    ) {
      throw new Error("Only secure, same-origin portal documents can be previewed.");
    }

    const params = previewUrl.searchParams;
    const allowedKeys = new Set(["a", "id", "file_id", "preview", "t", "pdf"]);
    for (const key of params.keys()) {
      if (!allowedKeys.has(key) || params.getAll(key).length !== 1) {
        throw new Error("This document link contains unsupported parameters.");
      }
    }
    if (params.get("preview") !== "1") {
      throw new Error("A preview-enabled portal document link is required.");
    }

    const action = params.get("a");
    if (!/^[1-9]\d*$/.test(params.get("id") || "")) {
      throw new Error("This document link has an invalid record ID.");
    }
    if (action === "request_download") {
      const file = /^[1-9]\d*$/.test(params.get("file_id") || "") && !params.has("pdf");
      const pdf = ["result", "receipt"].includes(params.get("pdf")) && !params.has("file_id");
      if ((!file && !pdf) || params.has("t")) {
        throw new Error("This request document link is incomplete.");
      }
    } else if (action === "download") {
      const type = params.get("t");
      if (!["evidence", "affidavit"].includes(type || "")) {
        throw new Error("This portal document link is incomplete.");
      }
      if (params.has("pdf") || params.has("file_id")) {
        throw new Error("This document link contains unsupported parameters.");
      }
    } else if (action === "user_face_preview" || action === "request_face_preview") {
      if (!/^[1-9]\d*$/.test(params.get("id") || "") || params.get("preview") !== "1" ||
          [...params.keys()].some(key => !["a", "id", "preview"].includes(key))) {
        throw new Error("This camera photo link is incomplete.");
      }
    } else {
      throw new Error("This type of portal document cannot be previewed.");
    }

    const downloadUrl = new URL(previewUrl.href);
    downloadUrl.searchParams.delete("preview");
    return { previewUrl: previewUrl.href, downloadUrl: downloadUrl.href };
  }

  function ensureDialog() {
    if (dialog) return;

    dialog = document.createElement("dialog");
    dialog.className = "document-viewer";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "document-viewer-title");

    const layout = document.createElement("div");
    layout.className = "document-viewer__layout";

    const header = document.createElement("header");
    header.className = "document-viewer__header";
    const heading = document.createElement("div");
    heading.className = "document-viewer__heading";
    const eyebrow = document.createElement("span");
    eyebrow.className = "document-viewer__eyebrow";
    eyebrow.textContent = "Secure document preview";
    titleElement = document.createElement("h2");
    titleElement.className = "document-viewer__title";
    titleElement.id = "document-viewer-title";
    heading.append(eyebrow, titleElement);

    const actions = document.createElement("div");
    actions.className = "document-viewer__actions";
    downloadElement = document.createElement("a");
    downloadElement.className = "document-viewer__download";
    downloadElement.textContent = "Download original";
    downloadElement.setAttribute("aria-label", "Download original document");
    const closeButton = document.createElement("button");
    closeButton.className = "document-viewer__close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close document preview");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    actions.append(downloadElement, closeButton);
    header.append(heading, actions);

    bodyElement = document.createElement("section");
    bodyElement.className = "document-viewer__body";
    bodyElement.setAttribute("aria-label", "Document preview");
    statusElement = document.createElement("p");
    statusElement.className = "document-viewer__footer";
    statusElement.setAttribute("role", "status");
    statusElement.setAttribute("aria-live", "polite");

    layout.append(header, bodyElement, statusElement);
    dialog.append(layout);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) close();
    });
    document.body.append(dialog);
  }

  function releaseObjectUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  }

  function destroyPdfResources() {
    activePdfRenderVersion += 1;
    if (activePdfResizeObserver) {
      activePdfResizeObserver.disconnect();
      activePdfResizeObserver = null;
    }
    if (activePdfRenderTask) {
      try {
        activePdfRenderTask.cancel();
      } catch {
        // The render task may have completed between the state check and cancel.
      }
      activePdfRenderTask = null;
    }
    if (activePdfLoadingTask) {
      const loadingTask = activePdfLoadingTask;
      activePdfLoadingTask = null;
      loadingTask.destroy().catch(() => {});
    }
    activePdfDocument = null;
    activePdfStage = null;
    activePdfCanvas = null;
    activePdfPageLabel = null;
    activePdfPreviousButton = null;
    activePdfNextButton = null;
    activePdfPageCount = 0;
    activePdfLastStageWidth = 0;
  }

  function cleanupResources() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    destroyPdfResources();
    releaseObjectUrl();
    if (sessionObserver) {
      sessionObserver.disconnect();
      sessionObserver = null;
    }
    window.clearTimeout(sessionCheckTimer);
    sessionCheckTimer = 0;
  }

  function stopSessionWatch() {
    if (sessionObserver) {
      sessionObserver.disconnect();
      sessionObserver = null;
    }
    window.clearTimeout(sessionCheckTimer);
    sessionCheckTimer = 0;
  }

  function watchSession() {
    stopSessionWatch();
    const root = appRoot();
    if (!root || !("MutationObserver" in window)) return;
    const verifySession = () => {
      window.clearTimeout(sessionCheckTimer);
      sessionCheckTimer = window.setTimeout(() => {
        if (dialog?.open && !root.contains(document.getElementById("lo"))) close();
      }, 120);
    };
    sessionObserver = new MutationObserver(verifySession);
    sessionObserver.observe(root, { childList: true, subtree: true });
    verifySession();
  }

  function renderMessage(kind, heading, message) {
    bodyElement.className = "document-viewer__body";
    bodyElement.replaceChildren();
    const wrapper = document.createElement("div");
    wrapper.className = `document-viewer__message document-viewer__message--${kind}`;
    if (kind === "error") wrapper.setAttribute("role", "alert");
    const title = document.createElement("h3");
    title.textContent = heading;
    const description = document.createElement("p");
    description.textContent = message;
    wrapper.append(title, description);
    bodyElement.append(wrapper);
    statusElement.textContent = kind === "loading" ? "Loading document preview…" : "";
  }

  function showError(message) {
    if (!dialog?.open) return;
    renderMessage("error", "Preview unavailable", message);
    statusElement.textContent = "The original file is still available to download.";
  }

  function installPreview(mimeType, blob, sequence, filename, plainText = "") {
    if (!dialog?.open || sequence !== requestSequence) return;
    bodyElement.replaceChildren();
    bodyElement.className = "document-viewer__body";

    if (mimeType === "application/pdf") {
      bodyElement.classList.add("document-viewer__body--pdf");
      createPdfPreview(blob, sequence, filename);
      return;
    }

    if (mimeType === "image/png" || mimeType === "image/jpeg") {
      activeObjectUrl = URL.createObjectURL(blob);
      const imageWrap = document.createElement("div");
      imageWrap.className = "document-viewer__image-wrap";
      const image = document.createElement("img");
      image.className = "document-viewer__image";
      image.alt = `${filename} preview`;
      image.addEventListener("error", () => {
        if (sequence === requestSequence && dialog?.open) showError("This image could not be displayed. Try downloading the original file.");
      });
      image.src = activeObjectUrl;
      imageWrap.append(image);
      bodyElement.append(imageWrap);
      statusElement.textContent = "Image preview.";
      return;
    }

    const text = document.createElement("pre");
    text.className = "document-viewer__text";
    text.textContent = plainText;
    bodyElement.append(text);
    statusElement.textContent = "Plain-text preview.";
  }

  function createPdfButton(label, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `document-viewer__pdf-button${className ? ` ${className}` : ""}`;
    button.textContent = label;
    button.setAttribute("aria-label", action === "previous"
      ? "Previous PDF page"
      : action === "next"
        ? "Next PDF page"
        : action === "zoom-out"
          ? "Zoom out"
          : action === "zoom-in"
            ? "Zoom in"
            : "Fit PDF to width");
    button.dataset.pdfAction = action;
    return button;
  }

  function createPdfPreview(blob, sequence, filename) {
    const toolbar = document.createElement("nav");
    toolbar.className = "document-viewer__pdf-toolbar";
    toolbar.setAttribute("aria-label", "PDF page and zoom controls");
    activePdfPreviousButton = createPdfButton("Previous", "previous");
    activePdfPreviousButton.disabled = true;
    activePdfNextButton = createPdfButton("Next", "next");
    activePdfNextButton.disabled = true;
    const pageLabel = document.createElement("span");
    pageLabel.className = "document-viewer__pdf-page-count";
    pageLabel.setAttribute("aria-live", "polite");
    pageLabel.textContent = "Loading pages";
    activePdfPageLabel = pageLabel;
    const spacer = document.createElement("span");
    spacer.className = "document-viewer__pdf-toolbar-spacer";
    const zoomOut = createPdfButton("−", "zoom-out");
    const zoomIn = createPdfButton("+", "zoom-in");
    const fit = createPdfButton("Fit width", "fit");
    toolbar.append(activePdfPreviousButton, activePdfNextButton, pageLabel, spacer, zoomOut, zoomIn, fit);

    activePdfStage = document.createElement("div");
    activePdfStage.className = "document-viewer__pdf-stage";
    activePdfStage.setAttribute("role", "region");
    activePdfStage.setAttribute("aria-label", `${filename} PDF page preview`);
    const loading = document.createElement("div");
    loading.className = "document-viewer__pdf-loading";
    loading.setAttribute("role", "status");
    loading.textContent = "Preparing PDF preview…";
    activePdfStage.append(loading);
    bodyElement.append(toolbar, activePdfStage);
    statusElement.textContent = "Loading PDF document…";
    activePdfPageNumber = 1;
    activePdfPageCount = 0;
    activePdfZoom = 1;

    toolbar.addEventListener("click", event => {
      const button = event.target.closest("button[data-pdf-action]");
      if (!button || button.disabled || sequence !== requestSequence || !dialog?.open) return;
      switch (button.dataset.pdfAction) {
        case "previous":
          showPdfPage(activePdfPageNumber - 1, sequence);
          break;
        case "next":
          showPdfPage(activePdfPageNumber + 1, sequence);
          break;
        case "zoom-out":
          activePdfZoom = Math.max(0.5, Math.round((activePdfZoom - 0.2) * 100) / 100);
          renderPdfPage(activePdfPageNumber, sequence);
          break;
        case "zoom-in":
          activePdfZoom = Math.min(3, Math.round((activePdfZoom + 0.2) * 100) / 100);
          renderPdfPage(activePdfPageNumber, sequence);
          break;
        case "fit":
          activePdfZoom = 1;
          renderPdfPage(activePdfPageNumber, sequence);
          break;
        default:
          break;
      }
    });
    loadPdf(blob, sequence, filename);
  }

  function loadPdfJs() {
    if (!pdfjsModulePromise) {
      const moduleUrl = new URL("pdfjs.php/build/pdf.mjs", window.location.href);
      if (moduleUrl.origin !== window.location.origin) {
        return Promise.reject(new Error("The local PDF renderer is not available on this portal origin."));
      }
      pdfjsModulePromise = import(moduleUrl.href).then(pdfjs => {
        const workerUrl = new URL("pdfjs.php/build/pdf.worker.mjs", window.location.href);
        const rendererUrl = new URL("pdfjs.php/build/pdf.renderer.mjs", window.location.href);
        if (workerUrl.origin !== window.location.origin || rendererUrl.origin !== window.location.origin) {
          throw new Error("The local PDF worker is not available on this portal origin.");
        }
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;
        pdfjs.GlobalWorkerOptions.rendererSrc = rendererUrl.href;
        return pdfjs;
      }).catch(error => {
        pdfjsModulePromise = null;
        throw error;
      });
    }
    return pdfjsModulePromise;
  }

  function pdfAssetBase(asset) {
    const url = new URL(`pdfjs.php/${encodeURIComponent(asset)}/`, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("A required PDF preview asset is not available on this portal origin.");
    }
    return url.href;
  }

  async function loadPdf(blob, sequence, filename) {
    try {
      if (blob.size > MAX_PDF_BYTES) {
        throw new Error("This PDF is too large to preview safely here. Download the original file instead.");
      }
      const pdfjs = await loadPdfJs();
      if (!dialog?.open || sequence !== requestSequence) return;
      const data = new Uint8Array(await blob.arrayBuffer());
      if (!dialog?.open || sequence !== requestSequence) return;
      const loadingTask = pdfjs.getDocument({
        data,
        isEvalSupported: false,
        enableXfa: false,
        stopAtErrors: true,
        cMapPacked: true,
        cMapUrl: pdfAssetBase("cmaps"),
        standardFontDataUrl: pdfAssetBase("standard_fonts"),
        wasmUrl: pdfAssetBase("wasm"),
        canvasMaxAreaInBytes: PDF_CANVAS_PIXEL_BUDGET,
        maxImageSize: PDF_CANVAS_PIXEL_BUDGET,
        useWorkerFetch: true
      });
      activePdfLoadingTask = loadingTask;
      const pdf = await loadingTask.promise;
      if (!dialog?.open || sequence !== requestSequence) return;
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new Error(`This PDF has more than ${MAX_PDF_PAGES.toLocaleString()} pages and cannot be previewed safely.`);
      }
      activePdfDocument = pdf;
      activePdfPageCount = pdf.numPages;
      activePdfPageLabel.textContent = `Page 1 of ${pdf.numPages}`;
      activePdfPreviousButton.disabled = true;
      activePdfNextButton.disabled = pdf.numPages <= 1;
      statusElement.textContent = `${filename} — page 1 of ${pdf.numPages}.`;
      observePdfWidth(sequence);
      await renderPdfPage(1, sequence);
    } catch (error) {
      if (sequence !== requestSequence || !dialog?.open || error?.name === "AbortException") return;
      destroyPdfResources();
      showError(pdfErrorMessage(error));
    }
  }

  function pdfErrorMessage(error) {
    if (error?.name === "PasswordException") {
      return "This PDF is encrypted or password-protected. For security, password prompts are not supported in the preview. Download the original file.";
    }
    if (error?.name === "InvalidPDFException" || error?.name === "FormatError") {
      return "This PDF appears malformed or damaged and could not be rendered. Download the original file.";
    }
    if (error?.name === "MissingPDFException") {
      return "The PDF data is incomplete or unavailable. Download the original file.";
    }
    if (error?.name === "UnexpectedResponseException") {
      return "A required PDF rendering resource could not be loaded from this portal. Download the original file.";
    }
    if (error?.message?.includes("too large") || error?.message?.includes("pages and cannot")) {
      return error.message;
    }
    return "This PDF could not be opened. It may be damaged or use an unsupported feature. Download the original file.";
  }

  function observePdfWidth(sequence) {
    if (!activePdfStage || !("ResizeObserver" in window)) return;
    activePdfResizeObserver = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      if (
        width > 0 &&
        Math.abs(width - activePdfLastStageWidth) > 2 &&
        sequence === requestSequence &&
        activePdfDocument
      ) {
        renderPdfPage(activePdfPageNumber, sequence);
      }
    });
    activePdfResizeObserver.observe(activePdfStage);
  }

  function pdfStageContentWidth() {
    const style = window.getComputedStyle(activePdfStage);
    return Math.max(
      200,
      activePdfStage.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
    );
  }

  function showPdfPage(pageNumber, sequence) {
    if (!activePdfDocument || sequence !== requestSequence) return;
    const bounded = Math.max(1, Math.min(activePdfPageCount, pageNumber));
    if (bounded === activePdfPageNumber && activePdfCanvas) return;
    activePdfPageNumber = bounded;
    activePdfPageLabel.textContent = `Page ${bounded} of ${activePdfPageCount}`;
    activePdfPreviousButton.disabled = bounded <= 1;
    activePdfNextButton.disabled = bounded >= activePdfPageCount;
    renderPdfPage(bounded, sequence);
  }

  async function renderPdfPage(pageNumber, sequence) {
    if (!activePdfDocument || !activePdfStage || sequence !== requestSequence) return;
    const renderVersion = ++activePdfRenderVersion;
    if (activePdfRenderTask) {
      try {
        activePdfRenderTask.cancel();
      } catch {
        // A completed task does not need cancellation.
      }
      activePdfRenderTask = null;
    }
    activePdfStage.setAttribute("aria-busy", "true");
    statusElement.textContent = `Rendering page ${pageNumber} of ${activePdfPageCount}…`;
    try {
      const page = await activePdfDocument.getPage(pageNumber);
      if (!isCurrentPdfRender(sequence, renderVersion)) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const stageWidth = pdfStageContentWidth();
      const fitScale = stageWidth / baseViewport.width;
      const cssScale = Math.min(
        fitScale * activePdfZoom,
        5,
        PDF_MAX_CANVAS_EDGE / baseViewport.width,
        PDF_MAX_CANVAS_EDGE / baseViewport.height
      );
      const viewport = page.getViewport({ scale: cssScale });
      let outputScale = Math.min(window.devicePixelRatio || 1, 2);
      outputScale = Math.min(
        outputScale,
        Math.sqrt(PDF_CANVAS_PIXEL_BUDGET / (viewport.width * viewport.height)),
        PDF_MAX_CANVAS_EDGE / viewport.width,
        PDF_MAX_CANVAS_EDGE / viewport.height
      );
      outputScale = Math.max(Number.MIN_VALUE, outputScale);

      const canvas = document.createElement("canvas");
      canvas.className = "document-viewer__canvas";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Page ${pageNumber} of ${activePdfPageCount} of the PDF`);
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas rendering is unavailable in this browser.");

      const previousCanvas = activePdfCanvas;
      activePdfCanvas = canvas;
      if (previousCanvas) previousCanvas.width = previousCanvas.height = 0;
      activePdfStage.replaceChildren(canvas);
      activePdfLastStageWidth = pdfStageContentWidth();

      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
        background: "#ffffff"
      });
      activePdfRenderTask = renderTask;
      await renderTask.promise;
      if (!isCurrentPdfRender(sequence, renderVersion)) return;
      activePdfStage.removeAttribute("aria-busy");
      statusElement.textContent = `Page ${pageNumber} of ${activePdfPageCount}.`;
    } catch (error) {
      if (!isCurrentPdfRender(sequence, renderVersion)) return;
      activePdfStage.removeAttribute("aria-busy");
      if (error?.name === "RenderingCancelledException" || error?.name === "AbortException") return;
      destroyPdfResources();
      showError(pdfErrorMessage(error));
    } finally {
      if (renderVersion === activePdfRenderVersion) activePdfRenderTask = null;
    }
  }

  function isCurrentPdfRender(sequence, renderVersion) {
    return dialog?.open &&
      sequence === requestSequence &&
      renderVersion === activePdfRenderVersion &&
      !!activePdfDocument;
  }

  async function loadDocument(urls, filename, sequence) {
    activeController = new AbortController();
    try {
      const response = await fetch(urls.previewUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: activeController.signal
      });
      if (!dialog?.open || sequence !== requestSequence) return;
      if (response.status === 401 || response.status === 403) {
        close();
        return;
      }
      if (!response.ok) {
        throw new Error(response.status === 404
          ? "The document could not be found. It may have been removed."
          : `The document could not be loaded (HTTP ${response.status}).`);
      }

      const mimeType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!MIME_TYPES.has(mimeType)) {
        throw new Error("This file type cannot be previewed here. Use Download original to open the authenticated file.");
      }
      const contentLength = Number(response.headers.get("Content-Length"));
      if (mimeType === "application/pdf" && Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
        throw new Error("This PDF is too large to preview safely here. Download the original file instead.");
      }
      const blob = await response.blob();
      if (!dialog?.open || sequence !== requestSequence) return;
      if (mimeType === "text/plain") {
        const text = await blob.text();
        if (!dialog?.open || sequence !== requestSequence) return;
        installPreview(mimeType, blob, sequence, filename, text);
      } else {
        installPreview(mimeType, blob, sequence, filename);
      }
    } catch (error) {
      if (error?.name === "AbortError" || sequence !== requestSequence || !dialog?.open) return;
      showError(error instanceof Error ? error.message : "The document could not be loaded. Try downloading the original.");
    } finally {
      if (sequence === requestSequence) activeController = null;
    }
  }

  function openFromTrigger(trigger) {
    let urls;
    const filename = safeFilename(trigger.getAttribute("data-document-viewer-name"));
    if (dialog?.open) close();
    cleanupResources();
    try {
      urls = validatedUrls(trigger.getAttribute("data-document-viewer-url") || "");
    } catch (error) {
      ensureDialog();
      requestSequence += 1;
      activeTrigger = trigger;
      titleElement.textContent = filename;
      downloadElement.removeAttribute("href");
      downloadElement.removeAttribute("download");
      renderMessage("error", "Preview unavailable", error.message);
      if (!dialog.open) dialog.showModal();
      dialog.querySelector(".document-viewer__close").focus();
      watchSession();
      return;
    }

    ensureDialog();
    activeTrigger = trigger;
    titleElement.textContent = filename;
    downloadElement.href = urls.downloadUrl;
    downloadElement.download = filename;
    downloadElement.setAttribute("aria-label", `Download original: ${filename}`);
    renderMessage("loading", "Loading document", "The secure preview is being prepared.");
    const sequence = ++requestSequence;
    dialog.showModal();
    dialog.querySelector(".document-viewer__close").focus();
    watchSession();
    loadDocument(urls, filename, sequence);
  }

  function close() {
    if (dialog?.open) dialog.close();
    bodyElement?.replaceChildren();
    cleanupResources();
    requestSequence += 1;
    const trigger = activeTrigger;
    activeTrigger = null;
    if (trigger?.isConnected && !trigger.disabled && trigger.getAttribute("aria-hidden") !== "true") {
      try {
        trigger.focus({ preventScroll: true });
      } catch {
        trigger.focus();
      }
    }
  }

  function isNavigationClick(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest("#lo, [data-signout], [data-logout], .app-nav button, [data-tab], [data-route]")) return true;
    const link = target.closest("#app a[href]");
    if (!link) return false;
    try {
      return new URL(link.href, window.location.href).href !== window.location.href;
    } catch {
      return true;
    }
  }

  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    const trigger = target?.closest("button[data-document-viewer-url][data-document-viewer-name]");
    if (trigger) {
      event.preventDefault();
      openFromTrigger(trigger);
      return;
    }
    if (dialog?.open && isNavigationClick(target)) close();
  }, true);

  window.addEventListener("popstate", close);
  window.addEventListener("hashchange", close);
  window.addEventListener("pagehide", close);

  window.DocumentViewer = Object.freeze({ close });
})();
