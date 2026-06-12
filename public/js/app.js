// Upload zone
const zone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const progFill = document.getElementById('prog-fill');
const uploadStatus = document.getElementById('upload-status');

if (zone) {
  zone.addEventListener('click', () => fileInput.click());

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => handleFiles(fileInput.files));
}

async function handleFiles(files) {
  for (const file of files) {
    await uploadFile(file);
  }
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  uploadProgress.style.display = 'block';
  progFill.style.width = '10%';
  uploadStatus.textContent = `Uploading ${file.name}...`;

  try {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 90);
        progFill.style.width = pct + '%';
      }
    });

    await new Promise((resolve, reject) => {
      xhr.open('POST', '/upload');
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText);
        if (data.success) {
          progFill.style.width = '100%';
          uploadStatus.innerHTML = `✅ Uploaded! <a href="${data.url}" target="_blank">View file</a>`;
          setTimeout(() => location.reload(), 1200);
          resolve();
        } else {
          uploadStatus.innerHTML = `<span style="color:var(--red)">❌ ${data.error}</span>`;
          progFill.style.width = '0%';
          reject();
        }
      };
      xhr.onerror = reject;
      xhr.send(formData);
    });
  } catch (e) {
    if (!uploadStatus.textContent.includes('❌')) {
      uploadStatus.innerHTML = '<span style="color:var(--red)">❌ Upload failed. Try again.</span>';
    }
    progFill.style.width = '0%';
  }
}

// Copy buttons
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(btn.dataset.url);
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
});

// Delete buttons
document.querySelectorAll('.delete-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!confirm('Delete this file?')) return;
    const r = await fetch('/files/' + btn.dataset.id, { method: 'DELETE' });
    const data = await r.json();
    if (data.success) btn.closest('tr').remove();
    else alert('Delete failed.');
  });
});
