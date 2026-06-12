/* AlzCloud — Global JS */

// ── Toast ─────────────────────────────────────────────────────────────────
(function() {
  const TOAST_HTML = `
    <div id="alz-toast">
      <svg id="alz-toast-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"></svg>
      <span id="alz-toast-msg"></span>
    </div>`;
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('alz-toast')) {
      document.body.insertAdjacentHTML('beforeend', TOAST_HTML);
    }
  });
})();

function alzToast(msg, type = 'success') {
  let toast = document.getElementById('alz-toast');
  if (!toast) {
    document.body.insertAdjacentHTML('beforeend', '<div id="alz-toast"><svg id="alz-toast-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"></svg><span id="alz-toast-msg"></span></div>');
    toast = document.getElementById('alz-toast');
  }
  const icon = document.getElementById('alz-toast-icon');
  const colors = { success: 'var(--green)', error: 'var(--red)', info: 'var(--accent2)' };
  const paths = {
    success: '<polyline points="20 6 9 17 4 12"/>',
    error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  };
  icon.innerHTML = paths[type] || paths.info;
  icon.style.color = colors[type] || colors.info;
  toast.style.borderColor = colors[type] || colors.info;
  document.getElementById('alz-toast-msg').textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Styled Modal (replaces alert/confirm) ─────────────────────────────────
function alzModal({ title, body, type = 'info', confirmText = 'OK', cancelText = null, onConfirm }) {
  document.querySelector('.alz-modal-overlay')?.remove();
  const icons = {
    warn: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    success: '<polyline points="20 6 9 17 4 12"/>',
  };
  const html = `
    <div class="alz-modal-overlay" id="alz-modal-overlay">
      <div class="alz-modal">
        <div class="alz-modal-icon ${type}">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[type]||icons.info}</svg>
        </div>
        <div class="alz-modal-title">${title}</div>
        <div class="alz-modal-body">${body}</div>
        <div class="alz-modal-actions">
          ${cancelText ? `<button class="btn btn-outline" id="alz-modal-cancel">${cancelText}</button>` : ''}
          <button class="btn ${type==='warn'?'btn-danger':'btn-primary'}" id="alz-modal-confirm">${confirmText}</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('alz-modal-overlay');
  const close = () => overlay.remove();
  document.getElementById('alz-modal-confirm').onclick = () => { close(); if (onConfirm) onConfirm(); };
  document.getElementById('alz-modal-cancel')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  requestAnimationFrame(() => overlay.classList.add('open'));
}

// ── Upload zone (dashboard) ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');
  const progress = document.getElementById('upload-progress');
  const bar = document.getElementById('upload-bar');
  const status = document.getElementById('upload-status');

  if (!zone || !input) return;

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); });

  function uploadFiles(files) {
    Array.from(files).forEach(file => uploadSingle(file));
  }

  function uploadSingle(file) {
    const fd = new FormData();
    fd.append('file', file);

    if (progress) { progress.style.display = 'block'; bar.style.width = '0%'; }
    if (status) status.textContent = `Uploading ${file.name}...`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && bar) bar.style.width = Math.round(e.loaded / e.total * 100) + '%';
    };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (d.success) {
          alzToast(`${file.name} uploaded!`, 'success');
          if (status) status.textContent = 'Upload complete. Refreshing...';
          setTimeout(() => location.reload(), 1200);
        } else {
          alzToast(d.error || 'Upload failed.', 'error');
          if (progress) progress.style.display = 'none';
          if (status) status.textContent = '';
        }
      } catch(e) {
        alzToast('Upload failed — unexpected response.', 'error');
      }
    };
    xhr.onerror = () => alzToast('Network error during upload.', 'error');
    xhr.send(fd);
  }

  // Delete file buttons
  document.querySelectorAll('[data-delete-file]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteFile;
      const name = btn.dataset.name || 'this file';
      alzModal({
        title: 'Delete File',
        body: `Permanently delete <strong>${name}</strong>? This cannot be undone.`,
        type: 'warn',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        onConfirm: async () => {
          try {
            const r = await fetch('/files/' + id, { method: 'DELETE' });
            const d = await r.json();
            if (d.success) {
              alzToast('File deleted.', 'success');
              btn.closest('tr')?.remove();
            } else {
              alzToast(d.error || 'Delete failed.', 'error');
            }
          } catch(e) {
            alzToast('Delete failed.', 'error');
          }
        }
      });
    });
  });

  // Copy link buttons
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => alzToast('Link copied!', 'success'));
    });
  });

  // Upgrade success
  if (window.location.search.includes('upgraded=1')) {
    alzToast('Plan upgraded successfully!', 'success');
  }
});
