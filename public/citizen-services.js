'use strict';
(() => {
  let locationWatch = null, hasLocationWatch = false, watchIdKnown = false, locationPoint = null, locationGeneration = 0;
  let dashboardActive = false, dashboardVisit = false, autoAttempted = false, locationState = 'overview', locationError = '';
  const MAX_FILE = 10 * 1024 * 1024;
  const requestsFor = (S, kind) => (S.requests || []).filter(r => !kind || r.kind === kind).slice().sort((a,b) => Number(b.created || 0) - Number(a.created || 0));
  const fileUrl = (id, fileId) => `api.php?a=request_download&id=${encodeURIComponent(id)}&file_id=${encodeURIComponent(fileId)}`;
  const pdfUrl = (id, which) => `api.php?a=request_download&id=${encodeURIComponent(id)}&pdf=${which}`;
  const resultLabel = req => req.result_format === 'stamped_document'
    ? (req.kind === 'affidavit' ? 'Download Affidavit Report PDF' : 'Download stamped document copy PDF')
    : 'Download review record PDF (legacy)';
  const statusClass = status => ({'Pending review':'Pending','In review':'Assigned','Approved':'Approved','Rejected':'Rejected'}[status] || String(status || '').toLowerCase().replace(/[^a-z]+/g,'-'));
  function fileLinks(req) {
    const staff = typeof S !== 'undefined' && ['officer','admin'].includes(S?.me?.role);
    return (req.files || []).map(file => `<a class="service-file" href="${fileUrl(req.id,file.id)}" download>${escapeHtml(file.kind || file.filename)} · Download <small>${Math.ceil(Number(file.size || 0)/1024)} KB</small></a>${staff ? `<button type="button" class="ghost" data-document-viewer-url="${fileUrl(req.id,file.id)}&amp;preview=1" data-document-viewer-name="${escapeHtml(file.filename)}">View ${escapeHtml(file.kind === 'selfie' ? 'camera capture' : file.kind === 'id_proof' ? 'ID proof' : file.kind)}</button>` : ''}`).join('');
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function submissionCard(req, when, owner=false) {
    const kind = req.kind === 'affidavit' ? 'Affidavit' : 'Document certification';
    const details = owner && req.details ? `<details class="service-details"><summary>Submitted details</summary><dl><dt>ID number</dt><dd>${escapeHtml(req.details.id_number || '—')}</dd>${req.details.race ? `<dt>Race (self-described)</dt><dd>${escapeHtml(req.details.race)}</dd>` : ''}${req.details.document_type ? `<dt>Document type</dt><dd>${escapeHtml(req.details.document_type)}</dd>` : ''}${req.details.reason ? `<dt>Reason</dt><dd>${escapeHtml(req.details.reason)}</dd>` : ''}${req.details.statement ? `<dt>Statement</dt><dd class="service-long">${escapeHtml(req.details.statement)}</dd>` : ''}</dl></details>` : '';
    return `<article class="service-request"><header><div><span class="service-ref">${escapeHtml(req.ref || `Request ${req.id}`)}</span><h3>${kind}</h3><small>${owner ? 'Submitted' : `Citizen: ${escapeHtml(req.citizen_name || 'Citizen')} · Submitted`} ${when(req.created)}</small></div><span class="chip ${statusClass(req.status)}">${escapeHtml(req.status)}</span></header>${!owner && req.officer_name ? `<p class="meta">Assigned to ${escapeHtml(req.officer_name)}</p>` : ''}${details}${owner ? `<div class="service-files">${fileLinks(req)}</div>` : ''}${req.note ? `<div class="service-note"><b>Review note</b><p>${escapeHtml(req.note)}</p></div>` : ''}${req.reviewer_name ? `<p class="meta">Reviewed by ${escapeHtml(req.reviewer_name)} (${escapeHtml(req.reviewer_role)}) · ${when(req.reviewed_at)}</p>` : ''}<div class="service-downloads">${req.has_receipt ? `<a href="${pdfUrl(req.id,'receipt')}">Submission receipt PDF</a>` : ''}${req.has_result ? `<a data-approved-pdf href="${pdfUrl(req.id,'result')}">${resultLabel(req)}</a>` : ''}</div></article>`;
  }
  function form(kind) {
    const affidavit = kind === 'affidavit', noun = affidavit ? 'affidavit' : 'document certification';
    const statement = affidavit ? `<label for="service-statement">Affidavit statement</label><textarea id="service-statement" name="statement" required minlength="20" maxlength="20000" aria-describedby="statement-help"></textarea><small id="statement-help" class="field-help">20–20,000 characters. Write the statement you are asking an Officer to review.</small>` :
      `<label for="service-document-type">Type of document</label><select id="service-document-type" name="document_type" required><option value="">Select document type</option>${['Identity document','Matric','Qualification','Others'].map(type=>`<option value="${type}">${type}</option>`).join('')}</select><label for="service-original">Original document</label><input id="service-original" name="original" type="file" required accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" data-file-kind="Original document" aria-describedby="original-help"><small id="original-help" class="field-help">PDF, PNG or JPEG · up to 10 MB.</small><label for="service-copy">Copy of document</label><input id="service-copy" name="copy" type="file" required accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" data-file-kind="Copy of document" aria-describedby="copy-help"><small id="copy-help" class="field-help">PDF, PNG or JPEG · up to 10 MB.</small>`;
    return `<form class="panel service-form" data-f="request_create" data-file novalidate>
      <input type="hidden" name="kind" value="${kind}">
      <div class="service-form-intro"><span class="eyebrow">SECURE SERVICE REQUEST</span><h2>Request ${affidavit ? 'an affidavit' : 'document certification'}</h2><p>Complete the required fields and attach clear files. An Officer will review your request; you can check its status below. A receipt is available after submission.</p></div>
      <label for="service-id-number">Identity document number</label><input id="service-id-number" name="id_number" required minlength="3" maxlength="30" autocomplete="off" aria-describedby="id-number-help" placeholder="Enter the number shown on your ID"><small id="id-number-help" class="field-help">Required · 3–30 letters, numbers, spaces or hyphens. Check the number before you continue.</small>
      <label for="service-race">Race <span class="optional-label">Optional · self-described</span></label><input id="service-race" name="race" type="text" maxlength="80" autocomplete="off">
      ${affidavit ? '<label for="service-reason">Why do you need this affidavit?</label><textarea id="service-reason" name="reason" required minlength="10" maxlength="2000" aria-describedby="reason-help" placeholder="Briefly explain what the affidavit is for"></textarea><small id="reason-help" class="field-help">Required · 10–2,000 characters.</small>' : ''}
      ${statement}
      ${affidavit ? '<label for="service-id-proof">Upload proof of identity</label><input id="service-id-proof" name="id_proof" type="file" required accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" data-file-kind="Identity proof" aria-describedby="proof-help"><small id="proof-help" class="field-help">Required · PDF, PNG or JPEG · up to 10 MB. Make sure the details can be read.</small>' : ''}
      ${window.FaceCamera.markup()}
      <aside class="service-privacy"><strong>What happens to your information?</strong><p>Your ID details, camera capture and attachments are shared with authorised Officers and Admin for review. A live camera capture is not automated face-to-ID matching.</p><p>An Officer checks your request. Remote review does not replace any required in-person inspection of originals or commissioning of an affidavit.</p><p>Only submit files you are comfortable sharing for this review. The server performs the final file checks.</p></aside>
      <label class="service-consent"><input type="checkbox" name="consent" value="yes" required> I consent to sharing this request and its attachments with the assigned Officer and Admin for review.</label>
      <p class="form-error" role="alert" aria-live="polite"></p><button type="submit">Submit ${noun} request</button>
    </form>`;
  }
  function stats(S) {
    const values = S.citizenStats || {};
    return [['total_cases','Cases filed'],['open_cases','Open cases'],['service_requests','Service requests'],['pending_requests','Awaiting review'],['approved_requests','Approved'],['total_submissions','Total submissions'],['active_sos','Active SOS']].map(([key,title]) => `<div class="panel citizen-stat" data-stat="${key}"><strong>${Number(values[key] || 0)}</strong><span>${title}</span></div>`).join('');
  }
  function locationMarkup() {
    const overview = !locationPoint;
    let src, title;
    if (overview) {
      const bbox = '15.5,-35.2,33.2,-21.8';
      src = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik`;
      title = 'South Africa overview map; no live location marker';
    } else {
      const {lat,lng} = locationPoint, d = .008;
      src = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(`${lng-d},${lat-d},${lng+d},${lat+d}`)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lng}`)}`;
      title = 'Map showing the browser-reported device location';
    }
    const status = locationState === 'locating' ? 'Waiting for browser permission or a GPS fix.'
      : locationState === 'paused' ? 'Location sharing is paused.'
      : locationState === 'error' ? locationError
      : locationPoint ? 'Live browser location is updating.'
      : 'South Africa overview · no current location shown.';
    const controls = locationPoint || locationState === 'locating'
      ? '<button class="ghost" type="button" data-do="citizen-location-stop">Pause location</button>'
      : locationState === 'paused'
        ? '<button type="button" data-do="citizen-location">Resume location</button>'
        : locationState === 'error'
          ? '<button type="button" data-do="citizen-location">Retry location</button>'
          : '<button type="button" data-do="citizen-location">Try location</button>';
    const liveMeta = locationPoint ? (() => {
      const {lat,lng} = locationPoint;
      const updated = new Date(locationPoint.timestamp).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'});
      const accuracy = Number.isFinite(locationPoint.accuracy) ? ` · accuracy ±${Math.round(locationPoint.accuracy)} m` : '';
      return `<b class="citizen-map-coordinates">${lat.toFixed(5)}, ${lng.toFixed(5)}</b><small>Updated ${updated}${accuracy}</small>`;
    })() : `<b class="citizen-map-overview-label">SOUTH AFRICA OVERVIEW</b><small>This is a country overview, not your current GPS position.</small>`;
    return `<div class="citizen-map"><iframe title="${title}" loading="lazy" referrerpolicy="no-referrer" src="${src}"></iframe><div class="citizen-map-meta"><b class="citizen-map-status" role="status" aria-live="polite">${escapeHtml(status)}</b>${liveMeta}<div class="citizen-map-controls">${controls}</div><p id="sos-location-error" class="form-error" role="status" aria-live="polite">${locationState === 'error' ? escapeHtml(locationError) : ''}</p></div><p class="field-help citizen-location-privacy">GPS is used only to display this map; it is not sent to the app API, stored, or used to create an SOS. Map tiles are provided by OpenStreetMap. Loading or moving the map shares its viewport coordinates with the map provider; a live view includes the displayed GPS area.</p></div>`;
  }
  function responseStation(S) {
    const alert = (S.sos || []).find(item => Number(item.ack_by) > 0);
    if (!alert) return '';
    const responseStatus = alert.status === 'Resolved' ? 'Officer response completed' : 'Officer is responding';
    return `<section class="panel citizen-response-station" aria-label="Officer response station">
      <div><span class="eyebrow">OFFICER RESPONSE STATION</span><h2>Pretoria Central Station</h2><p>${responseStatus}</p><small>Demo station assignment; this is not the Officer’s live GPS location.</small></div>
      <a class="ghost" href="https://www.openstreetmap.org/search?query=Pretoria%20Central%20Station" target="_blank" rel="noopener noreferrer">View station map ↗</a>
    </section>`;
  }
  function citizenView(tab, S, esc, when) {
    if (tab === 'affidavits' || tab === 'certifications') {
      const kind = tab === 'affidavits' ? 'affidavit' : 'certification', list = requestsFor(S,kind);
      return `<section class="section-heading"><span class="eyebrow">CITIZEN SERVICES</span><h1>${tab === 'affidavits' ? 'Request an affidavit' : 'Certify a document'}</h1><p>Send the required details and files for an Officer to review. You can follow the decision below.</p></section>${form(kind)}<section class="service-list-block"><div class="section-heading"><h2>Your ${kind === 'affidavit' ? 'affidavit' : 'document certification'} requests</h2><p>A submission receipt is available after each request is sent.</p></div>${list.length ? list.map(r=>submissionCard(r,when,true)).join('') : '<div class="empty">No requests submitted yet. After you send one, its status and receipt will appear here.</div>'}</section>`;
    }
    const entries = [
      ...(S.cases || []).map(item => ({type:'case', item, created:Number(item.created || 0)})),
      ...requestsFor(S).map(item => ({type:'request', item, created:Number(item.created || 0)}))
    ].sort((a,b) => b.created - a.created).slice(0,200);
    const activity = entries.map(({type,item}) => type === 'case'
      ? `<article class="service-request submission-summary"><header><div><span class="service-ref">${esc(item.ref || `Case ${item.id}`)}</span><h3>${esc(item.title || item.type || 'Crime report')}</h3><small>${esc(item.type || 'Crime report')} · Submitted ${when(item.created)}</small></div><span class="chip ${statusClass(item.status)}">${esc(item.status)}</span></header><button type="button" class="ghost" data-tab="cases">View case progress</button></article>`
      : submissionCard(item,when,true)).join('');
    return `<section class="citizen-welcome"><div><span class="eyebrow">CITIZEN WORKSPACE</span><h1>Welcome, ${esc(S.me.name.split(' ')[0])}.</h1><p>Start a report, request a document service or check your latest updates.</p></div><button class="citizen-sos-button" type="button" data-do="sos">Send emergency SOS</button></section>${responseStation(S)}
      <section class="citizen-stats" aria-label="Your activity">${stats(S)}</section>
      <div class="citizen-dashboard-grid"><section class="panel citizen-submissions"><div class="service-heading"><div><span class="eyebrow">RECENT ACTIVITY</span><h2>All submissions</h2></div><button type="button" class="ghost" data-tab="cases">View case progress</button></div>${activity || '<div class="empty">Your submissions will appear here. Start with a crime report, affidavit or document certification.</div>'}<p class="field-help">Showing the 200 newest available submissions at most. Request records are limited to the newest 200 by the service.</p></section>
      <section class="panel citizen-location-panel"><span class="eyebrow">BROWSER GPS · PRIVATE TO THIS VIEW</span><h2>Location map</h2><p>Your browser may ask to show your location here. This is separate from SOS and never raises an alert. You can pause or resume location sharing at any time.</p><div id="citizen-map-content">${locationMarkup()}</div></section></div>
      <section class="citizen-quick-links" aria-label="Common tasks"><button type="button" data-tab="report">Report crimes</button><button type="button" class="ghost" data-tab="affidavits">Request affidavit</button><button type="button" class="ghost" data-tab="certifications">Certify documents</button><button type="button" class="ghost" data-tab="cases">Cases &amp; progress</button></section>`;
  }
  function citizenCases(S, esc, when, cases, renderCase) {
    const requests = requestsFor(S);
    return `<section class="section-heading"><span class="eyebrow">YOUR RECORDS</span><h1>Cases &amp; progress</h1><p>Check the current status of incident reports and service requests. Updates appear here as they are reviewed.</p></section><h2 class="service-section-title">Service requests</h2>${requests.length ? requests.map(r=>submissionCard(r,when,true)).join('') : '<div class="empty">No service requests yet. Requests you send will appear here with their review status.</div>'}<h2 class="service-section-title">Incident reports</h2>${cases.length ? cases.map(renderCase).join('') : '<div class="empty">No incident reports yet. Choose “Report incident” to submit one and follow its progress here.</div>'}`;
  }
  function staffView(S, esc, when) {
    const requests = requestsFor(S);
    return `<section class="section-heading"><span class="eyebrow">SERVICE REVIEW</span><h1>Service requests</h1><p>Review affidavit and document certification requests. Check the supplied details and files before deciding. Only the submitting citizen, assigned Officer and Admin can view them.</p></section>${requests.length ? requests.map(req=>{
      const assigned = Number(req.officer_id) === Number(S.me.id), admin = S.me.role === 'admin', canClaim = !admin && !req.officer_id && req.status === 'Pending review', canReview = admin ? ['Pending review','In review'].includes(req.status) : assigned && req.status === 'In review';
        return `<article class="service-request"><header><div><span class="service-ref">${esc(req.ref || `Request ${req.id}`)}</span><h3>${req.kind === 'affidavit' ? 'Affidavit' : 'Document certification'}${admin || req.citizen_id !== S.me.id ? ` · ${esc(req.citizen_name || 'Citizen')}` : ''}</h3><small>Submitted ${when(req.created)} · Updated ${when(req.updated)}</small></div><span class="chip ${statusClass(req.status)}">${esc(req.status)}</span></header><p class="meta">Assigned Officer: ${esc(req.officer_name || 'Unassigned')}</p>${req.citizen_face_available ? `<button type="button" class="ghost" data-document-viewer-url="api.php?a=request_face_preview&amp;id=${Number(req.id)}&amp;preview=1" data-document-viewer-name="${esc(req.citizen_name || 'Citizen')} signup camera photo">View Citizen camera photo</button><p class="field-help">Compare visually with the submitted evidence. This is a human review; no automatic face matching is performed.</p>` : ''}${req.reviewer_name ? `<p class="meta">Reviewed by ${esc(req.reviewer_name)} (${esc(req.reviewer_role)}) · ${when(req.reviewed_at)}</p>` : ''}
      ${admin && !canReview && req.details ? `<div class="service-detail-view"><dl><dt>ID number</dt><dd>${esc(req.details.id_number || '—')}</dd>${req.details.race ? `<dt>Race (self-described)</dt><dd>${esc(req.details.race)}</dd>` : ''}<dt>Reason</dt><dd>${esc(req.details.reason || '—')}</dd>${req.details.statement ? `<dt>Statement</dt><dd class="service-long">${esc(req.details.statement)}</dd>` : ''}</dl><div class="service-files">${fileLinks(req)}</div></div>` : ''}
      ${assigned && !admin && !canReview && req.details ? `<div class="service-detail-view"><dl><dt>ID number</dt><dd>${esc(req.details.id_number || '—')}</dd>${req.details.race ? `<dt>Race (self-described)</dt><dd>${esc(req.details.race)}</dd>` : ''}<dt>Reason</dt><dd>${esc(req.details.reason || '—')}</dd>${req.details.statement ? `<dt>Statement</dt><dd class="service-long">${esc(req.details.statement)}</dd>` : ''}</dl><div class="service-files">${fileLinks(req)}</div></div>` : ''}
      ${req.details?.document_type ? `<p class="meta">Document type: ${esc(req.details.document_type)}</p>` : ''}
      ${canClaim ? `<form data-f="request_claim" novalidate><input type="hidden" name="id" value="${Number(req.id)}"><p class="form-error" role="alert" aria-live="polite"></p><button type="submit">Claim this request</button></form>` : ''}
       ${canReview ? `<details class="service-review"><summary>Review request</summary><div class="service-detail-view">${req.details ? `<dl><dt>ID number</dt><dd>${esc(req.details.id_number || '—')}</dd>${req.details.race ? `<dt>Race (self-described)</dt><dd>${esc(req.details.race)}</dd>` : ''}<dt>Reason</dt><dd>${esc(req.details.reason || '—')}</dd>${req.details.statement ? `<dt>Statement</dt><dd class="service-long">${esc(req.details.statement)}</dd>` : ''}</dl>` : '<p>Submitted details are not available in this response.</p>'}<div class="service-files">${fileLinks(req)}</div></div>${req.review_flag_reason ? `<div class="service-note"><b>Flagged for Admin review</b><p>${esc(req.review_flag_reason)}</p></div>` : ''}${S.me.role==='officer' ? `<form data-f="citizen_flag" novalidate><input type="hidden" name="request_id" value="${Number(req.id)}"><label for="citizen-flag-${Number(req.id)}">Flag Citizen account for Admin review</label><textarea id="citizen-flag-${Number(req.id)}" name="reason" required minlength="10" maxlength="500" placeholder="Describe the concern for Admin review."></textarea><small class="field-help">This flags the account for Admin review; it does not block Citizen sign-in.</small><p class="form-error" role="alert" aria-live="polite"></p><button type="submit" class="ghost">Flag account for Admin review</button></form>` : ''}<form data-f="request_review" novalidate><input type="hidden" name="id" value="${Number(req.id)}"><label for="review-note-${Number(req.id)}">Review note</label><textarea id="review-note-${Number(req.id)}" name="note" required minlength="10" maxlength="2000" aria-describedby="review-note-help-${Number(req.id)}"></textarea><small id="review-note-help-${Number(req.id)}" class="field-help">10–2,000 characters. This note is included in the workflow record.</small><label class="service-consent"><input type="checkbox" name="identity_checked" value="yes" required> I reviewed the identity details and camera capture manually.</label><label class="service-consent"><input type="checkbox" name="documents_checked" value="yes" required> I checked the submitted documents.</label><p class="field-help">Approval requires both confirmations. Remote review does not replace any required in-person original inspection or commissioning.</p><p class="form-error" role="alert" aria-live="polite"></p><div class="service-review-actions"><button type="submit" name="decision" value="approve">Approve request</button><button type="submit" name="decision" value="reject" class="bad">Reject request</button></div></form></details>` : ''}
      ${canReview ? `<p class="field-help">Approval adds your initial and surname as an electronic signature, with the server approval date and time. Rejection creates no signed PDF.</p>` : ''}
      ${req.note ? `<div class="service-note"><b>Review note</b><p>${esc(req.note)}</p></div>` : ''}<div class="service-downloads">${req.has_receipt ? `<a href="${pdfUrl(req.id,'receipt')}">Submission receipt PDF</a><button type="button" class="ghost" data-document-viewer-url="${pdfUrl(req.id,'receipt')}&amp;preview=1" data-document-viewer-name="${esc(req.ref)} receipt.pdf">View receipt PDF</button>` : ''}${req.has_result ? `<a href="${pdfUrl(req.id,'result')}">${resultLabel(req)}</a><button type="button" class="ghost" data-document-viewer-url="${pdfUrl(req.id,'result')}&amp;preview=1" data-document-viewer-name="${esc(req.ref)} approved.pdf">View approved PDF</button>` : ''}</div>${req.files?.length && (admin || assigned) ? '<p class="field-help">View supported documents securely in this portal, or download the original. No files are copied to OneDrive.</p>' : ''}${req.has_result ? '<p class="field-help">This immutable PDF records the reviewer, server timestamp and source file SHA-256 register. It has no cryptographic digital signature and is not automatic statutory certification; source originals remain unchanged.</p>' : ''}</article>`;
    }).join('') : '<div class="empty">No service requests to review right now. New requests will appear here after a citizen submits one.</div>'}<p class="field-help">Showing up to the 200 newest requests.</p>`;
  }
  function validateRequest(form) {
    const values = Object.fromEntries(new FormData(form)), id = String(values.id_number || '').trim(), reason = String(values.reason || '').trim(), statement = String(values.statement || '').trim();
    if (!/^[\p{L}\p{N} -]{3,30}$/u.test(id)) return 'Identity document number must be 3–30 letters, numbers, spaces or hyphens.';
    if (values.kind === 'affidavit' && (reason.length < 10 || reason.length > 2000)) return 'Reason must be 10–2,000 characters.';
    if (values.kind === 'certification' && !['Identity document','Matric','Qualification','Others'].includes(values.document_type)) return 'Select a document type.';
    if (values.kind === 'affidavit' && (statement.length < 20 || statement.length > 20000)) return 'Affidavit statement must be 20–20,000 characters.';
    if (values.consent !== 'yes') return 'Consent is required to share your request with the assigned Officer and Admin.';
    const imageOnly = new Set(['selfie']);
    for (const input of form.querySelectorAll('input[type=file]')) {
      const file = input.files?.[0];
      if (!file) return input.name === 'selfie' ? 'Start the camera and capture a photo for identity review.' : `Choose a file for ${input.dataset.fileKind || input.name}.`;
      const typeOk = imageOnly.has(input.name) ? ['image/png','image/jpeg'].includes(file.type) : ['application/pdf','image/png','image/jpeg'].includes(file.type);
      const extOk = imageOnly.has(input.name) ? /\.(png|jpe?g)$/i.test(file.name) : /\.(pdf|png|jpe?g)$/i.test(file.name);
      if (!typeOk && !extOk) return `${input.dataset.fileKind || input.name} must be a PDF, PNG or JPEG file${imageOnly.has(input.name) ? ' (PNG or JPEG only)' : ''}.`;
      if (file.size > MAX_FILE) return `${input.dataset.fileKind || input.name} must be 10 MB or smaller.`;
      if (!file.size) return `${input.dataset.fileKind || input.name} is empty.`;
    }
    return '';
  }
  function validateReview(form, values) {
    const note = String(values.note || '').trim();
    if (!['approve','reject'].includes(values.decision)) return 'Choose approve or reject.';
    if (note.length < 10 || note.length > 2000) return 'Review note is required and must be 10–2,000 characters.';
    if (values.decision === 'approve' && (values.identity_checked !== 'yes' || values.documents_checked !== 'yes')) return 'Confirm both identity and document checks before approval.';
    return '';
  }
  function currentDashboard() {
    return dashboardActive &&
      document.querySelector('.user-pill b')?.textContent.trim().toLowerCase() === 'citizen' &&
      !!document.querySelector('.app-nav [data-tab="dashboard"][aria-current="true"]') &&
      !!document.getElementById('citizen-map-content');
  }
  function paintLocation() {
    if (!currentDashboard()) return;
    const map = document.getElementById('citizen-map-content');
    if (map) map.innerHTML = locationMarkup();
  }
  function clearLocationWatch() {
    if (hasLocationWatch && watchIdKnown) navigator.geolocation?.clearWatch(locationWatch);
    locationWatch = null;
    hasLocationWatch = false;
    watchIdKnown = false;
  }
  function locationFailure(message) {
    locationGeneration++;
    clearLocationWatch();
    locationPoint = null;
    locationState = 'error';
    locationError = message;
    paintLocation();
  }
  function locationErrorMessage(error) {
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return 'GPS requires a secure HTTPS connection. Open this dashboard over HTTPS, then allow location in your browser settings and retry.';
    }
    if (error?.code === 1) return 'Location permission was denied. Allow location for this site in your browser settings, then retry.';
    if (error?.code === 2) return 'Your device could not determine a location. Check device location services and retry.';
    if (error?.code === 3) return 'The location request timed out. Keep location services enabled and retry.';
    return 'Location is unavailable. Check browser permission, device location services and the secure HTTPS connection, then retry.';
  }
  function startLocation() {
    if (!currentDashboard()) return;
    autoAttempted = true;
    if (hasLocationWatch || locationState === 'locating') return;
    locationPoint = null;
    locationError = '';
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      locationFailure('GPS requires a secure HTTPS connection. Open this dashboard over HTTPS, then allow location in your browser settings and retry.');
      return;
    }
    if (!navigator.geolocation) {
      locationFailure('This browser does not provide GPS location. Use a supported browser over HTTPS to enable location.');
      return;
    }
    const generation = ++locationGeneration;
    locationState = 'locating';
    const isCurrent = () => generation === locationGeneration && currentDashboard();
    paintLocation();
    try {
      // Set the active flag before calling the browser: test doubles and some
      // implementations can invoke a callback synchronously.
      hasLocationWatch = true;
      watchIdKnown = false;
      const watchId = navigator.geolocation.watchPosition(position => {
        if (!isCurrent() || !hasLocationWatch) return;
        const lat = Number(position?.coords?.latitude), lng = Number(position?.coords?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
        locationPoint = {
          lat, lng,
          accuracy: Number.isFinite(Number(position.coords.accuracy)) ? Number(position.coords.accuracy) : null,
          timestamp: Number(position.timestamp) || Date.now()
        };
        locationState = 'active';
        locationError = '';
        paintLocation();
      }, error => {
        if (!isCurrent() || !hasLocationWatch) return;
        locationFailure(locationErrorMessage(error));
      }, {enableHighAccuracy:true, maximumAge:10000, timeout:15000});
      if (generation !== locationGeneration || !dashboardActive) {
        navigator.geolocation.clearWatch(watchId);
        return;
      }
      locationWatch = watchId;
      watchIdKnown = true;
    } catch {
      if (isCurrent()) locationFailure(locationErrorMessage(null));
    }
  }
  function stopLocation() {
    locationGeneration++;
    clearLocationWatch();
    locationPoint = null;
    locationError = '';
    locationState = 'paused';
    if (dashboardActive) paintLocation();
  }
  function syncDashboard(active) {
    active = !!active;
    if (!active) {
      if (dashboardActive || hasLocationWatch || locationPoint) {
        locationGeneration++;
        clearLocationWatch();
        locationPoint = null;
        locationError = '';
      }
      dashboardActive = false;
      dashboardVisit = false;
      autoAttempted = false;
      locationState = 'overview';
      return;
    }
    dashboardActive = true;
    if (!dashboardVisit) {
      dashboardVisit = true;
      autoAttempted = false;
      locationState = 'overview';
      locationError = '';
      locationPoint = null;
    }
    if (!autoAttempted) startLocation();
  }
  window.addEventListener('pagehide', stopLocation);
  window.CitizenServices = {citizenView, citizenCases, staffView, validateRequest, validateReview, startLocation, stopLocation, syncDashboard};
})();
