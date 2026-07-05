/* AlzCloud — Global JS */

function alzCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content || '';
}

// Re-run whenever new data-lucide elements are injected dynamically.
function alzIcons() { if (window.lucide) window.lucide.createIcons(); }
document.addEventListener('DOMContentLoaded', alzIcons);

// ── Bottom nav active state ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  document.querySelectorAll('.tab-item[data-path]').forEach(el => {
    if (el.dataset.path === path) el.classList.add('active');
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────
function alzToast(msg, type = 'success') {
  let toast = document.getElementById('alz-toast');
  if (!toast) {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="alz-toast"><i id="alz-toast-icon"></i><span id="alz-toast-msg"></span></div>');
    toast = document.getElementById('alz-toast');
  }
  const iconName = { success: 'check-circle-2', error: 'x-circle', info: 'info' }[type] || 'info';
  const icon = document.getElementById('alz-toast-icon');
  icon.setAttribute('data-lucide', iconName);
  icon.innerHTML = '';
  document.getElementById('alz-toast-msg').textContent = msg;
  alzIcons();
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

// ── Styled modal (replaces alert/confirm) ─────────────────────────────────
function alzModal({ title, body, type = 'info', confirmText = 'OK', cancelText = null, onConfirm }) {
  document.querySelector('.alz-modal-overlay')?.remove();
  const iconName = { warn: 'alert-triangle', info: 'info', success: 'check-circle-2' }[type] || 'info';
  const html = `
    <div class="alz-modal-overlay" id="alz-modal-overlay">
      <div class="alz-modal">
        <div class="alz-modal-icon ${type}"><i data-lucide="${iconName}"></i></div>
        <div class="alz-modal-title">${title}</div>
        <div class="alz-modal-body">${body}</div>
        <div class="alz-modal-actions">
          ${cancelText ? `<button class="btn btn-outline" id="alz-modal-cancel">${cancelText}</button>` : ''}
          <button class="btn ${type === 'warn' ? 'btn-danger' : 'btn-primary'}" id="alz-modal-confirm">${confirmText}</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  alzIcons();
  const overlay = document.getElementById('alz-modal-overlay');
  const close = () => overlay.remove();
  document.getElementById('alz-modal-confirm').onclick = () => { close(); if (onConfirm) onConfirm(); };
  document.getElementById('alz-modal-cancel')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  requestAnimationFrame(() => overlay.classList.add('open'));
}

// ── Shared helpers ───────────────────────────────────────────────────────
function alzBytes(n) {
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
function alzIconForType(type, mime) {
  if (type === 'video') return 'video';
  if (type === 'image') return 'image';
  if (type === 'audio') return 'music';
  if (mime === 'application/pdf') return 'file-text';
  return 'file';
}
function alzCanPreview(type, mime) {
  return type === 'video' || type === 'image' || type === 'audio' || mime === 'application/pdf';
}

// ── Circular upload zone (home + dashboard FAB share this) ────────────────
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');
  if (!zone || !input) return;

  const endpoint = zone.dataset.endpoint || '/upload';
  const maxBytes = parseInt(zone.dataset.maxBytes || '0', 10);
  const resultWrap = document.getElementById('upload-result');
  const ring = zone.querySelector('.progress-ring .fill');
  const CIRCUMFERENCE = 276; // 2 * PI * r(44)
  if (ring) ring.style.strokeDasharray = CIRCUMFERENCE;

  function setProgress(pct) {
    if (!ring) return;
    ring.style.strokeDashoffset = CIRCUMFERENCE - (CIRCUMFERENCE * pct / 100);
  }

  zone.addEventListener('click', () => { if (!zone.classList.contains('busy')) input.click(); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) startUpload(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files.length) startUpload(input.files[0]); });

  function startUpload(file) {
    if (maxBytes && file.size > maxBytes) {
      alzToast(`Too large — max is ${alzBytes(maxBytes)}. Register for higher limits.`, 'error');
      return;
    }
    resultWrap && (resultWrap.innerHTML = '');
    zone.classList.add('busy');
    setProgress(0);
    const labelEl = zone.querySelector('.upload-label');
    const subEl = zone.querySelector('.upload-sub');
    if (labelEl) labelEl.textContent = 'Uploading…';
    if (subEl) subEl.textContent = file.name;

    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.setRequestHeader('X-CSRF-Token', alzCsrfToken());
    xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      zone.classList.remove('busy');
      if (labelEl) labelEl.textContent = 'Tap to upload';
      if (subEl) subEl.textContent = 'Any file, up to ' + (maxBytes ? alzBytes(maxBytes) : '2GB');
      setProgress(0);
      try {
        const d = JSON.parse(xhr.responseText);
        if (d.success) {
          alzToast('Uploaded!', 'success');
          if (resultWrap) renderResult(d);
          else setTimeout(() => location.reload(), 900);
        } else {
          alzToast(d.error || 'Upload failed.', 'error');
        }
      } catch (e) {
        alzToast('Upload failed — unexpected response.', 'error');
      }
    };
    xhr.onerror = () => {
      zone.classList.remove('busy');
      setProgress(0);
      alzToast('Network error during upload.', 'error');
    };
    xhr.send(fd);
  }

  function renderResult(d) {
    const iconName = alzIconForType(d.file_type, d.mime_type);
    const canPreview = alzCanPreview(d.file_type, d.mime_type);
    const previewUrl = d.download_url || null;
    let previewHtml = '';
    if (canPreview && previewUrl) {
      if (d.file_type === 'image') previewHtml = `<img class="result-preview" src="${previewUrl}" alt="${d.name}">`;
      else if (d.file_type === 'video') previewHtml = `<video class="result-preview" src="${previewUrl}" controls></video>`;
      else if (d.file_type === 'audio') previewHtml = `<audio class="w-full mt-2" src="${previewUrl}" controls style="width:100%"></audio>`;
      else if (d.mime_type === 'application/pdf') previewHtml = `<iframe class="result-preview" src="${previewUrl}" style="height:260px;border:none"></iframe>`;
    }
    resultWrap.innerHTML = `
      <div class="result-card">
        <div class="flex items-center gap-2">
          <div class="result-icon"><i data-lucide="${iconName}"></i></div>
          <div style="min-width:0;flex:1">
            <div class="file-name">${d.name}</div>
            <div class="file-sub">${d.size_human || ''}${canPreview ? ' · Live preview' : ''}</div>
          </div>
        </div>
        ${previewHtml}
        <div class="copy-row">
          <input class="form-input" readonly value="${d.url}" id="result-link">
          <button class="btn btn-primary btn-sm" id="result-copy"><i data-lucide="copy"></i></button>
        </div>
        <a href="${d.url}" class="btn btn-outline btn-block mt-2"><i data-lucide="external-link"></i> View file page</a>
      </div>`;
    alzIcons();
    document.getElementById('result-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(d.url).then(() => alzToast('Link copied!', 'success'));
    });
  }

  // Delete file buttons (dashboard file list)
  document.querySelectorAll('[data-delete-file]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteFile;
      const name = btn.dataset.name || 'this file';
      alzModal({
        title: 'Delete file', body: `Permanently delete <strong>${name}</strong>? This can't be undone.`,
        type: 'warn', confirmText: 'Delete', cancelText: 'Cancel',
        onConfirm: async () => {
          try {
            const r = await fetch('/files/' + id, { method: 'DELETE', headers: { 'X-CSRF-Token': alzCsrfToken() } });
            const d = await r.json();
            if (d.success) { alzToast('File deleted.', 'success'); btn.closest('.file-row')?.remove(); }
            else alzToast(d.error || 'Delete failed.', 'error');
          } catch (e) { alzToast('Delete failed.', 'error'); }
        }
      });
    });
  });

  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(() => alzToast('Copied!', 'success'));
    });
  });

  if (window.location.search.includes('upgraded=1')) alzToast('Plan upgraded successfully!', 'success');
});

// ── API apps management (dashboard) ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const createBtn = document.getElementById('create-app-btn');
  if (!createBtn) return;

  createBtn.addEventListener('click', () => {
    const wrap = document.getElementById('create-app-form');
    wrap.style.display = wrap.style.display === 'none' ? 'flex' : 'none';
    document.getElementById('new-app-name')?.focus();
  });

  document.getElementById('new-app-submit')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-app-name');
    const name = nameInput.value.trim();
    if (!name) { alzToast('Give your app a name.', 'error'); return; }
    try {
      const r = await fetch('/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': alzCsrfToken() },
        body: JSON.stringify({ name })
      });
      const d = await r.json();
      if (d.success) { alzToast('API app created.', 'success'); location.reload(); }
      else alzToast(d.error || 'Could not create app.', 'error');
    } catch (e) { alzToast('Could not create app.', 'error'); }
  });

  document.querySelectorAll('[data-delete-app]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteApp;
      const name = btn.dataset.name || 'this app';
      alzModal({
        title: 'Delete API app', body: `Delete <strong>${name}</strong>? Anything using this key will stop working immediately.`,
        type: 'warn', confirmText: 'Delete', cancelText: 'Cancel',
        onConfirm: async () => {
          try {
            const r = await fetch('/apps/' + id, { method: 'DELETE', headers: { 'X-CSRF-Token': alzCsrfToken() } });
            const d = await r.json();
            if (d.success) { alzToast('API app deleted.', 'success'); btn.closest('.app-card')?.remove(); }
            else alzToast(d.error || 'Delete failed.', 'error');
          } catch (e) { alzToast('Delete failed.', 'error'); }
        }
      });
    });
  });

  document.querySelectorAll('[data-copy-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copyKey).then(() => alzToast('Key copied!', 'success'));
    });
  });
});
