(() => {
  const listEl = document.getElementById('rig-approvals-list')
  const statusEl = document.getElementById('rig-approvals-status')
  const refreshButton = document.getElementById('rig-refresh')
  const filterStatus = document.getElementById('rig-filter-status')

  if (!listEl || !statusEl || !refreshButton || !filterStatus) {
    return
  }

  function setStatus(message, tone) {
    statusEl.textContent = message
    statusEl.className = 'text-sm rounded border px-3 py-2 mb-6'

    if (tone === 'error') {
      statusEl.classList.add('border-red-400/40', 'bg-red-900/20', 'text-red-200')
    } else if (tone === 'success') {
      statusEl.classList.add('border-green-400/40', 'bg-green-900/20', 'text-green-200')
    } else {
      statusEl.classList.add('border-white/20', 'bg-white/5', 'text-slate-200')
    }

    statusEl.classList.remove('hidden')
  }

  function hideStatus() {
    statusEl.classList.add('hidden')
  }

  function renderMedia(mediaItems) {
    if (!Array.isArray(mediaItems) || !mediaItems.length) {
      return '<p class="text-xs text-slate-500">No media uploaded.</p>'
    }

    return mediaItems
      .map((item) => {
        if (!item || !item.dataUrl) {
          return ''
        }

        if (String(item.type).startsWith('image/')) {
          return `<img src="${item.dataUrl}" alt="Rig media" class="rounded border border-white/10 max-h-56 object-cover"/>`
        }

        if (String(item.type).startsWith('video/')) {
          return `<video controls class="rounded border border-white/10 max-h-56" src="${item.dataUrl}"></video>`
        }

        return ''
      })
      .join('')
  }

  function renderSubmissionCard(submission) {
    const mediaItems = (() => {
      try {
        return JSON.parse(submission.media_items || '[]')
      } catch {
        return []
      }
    })()

    return `
      <article class="bg-surface border border-white/10 rounded-lg p-5 space-y-4" data-submission-id="${submission.id}">
        <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div>
            <h2 class="font-headline text-2xl font-bold">${submission.owner_name}</h2>
            <p class="text-sm text-slate-300">${submission.chassis_model}</p>
            <p class="text-xs text-slate-500 mt-1">Submitted: ${submission.submitted_at}</p>
          </div>
          <div class="text-xs uppercase tracking-widest px-2 py-1 rounded border border-white/20">${submission.status}</div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <p><span class="text-slate-500">Battery:</span> ${submission.battery || '—'}</p>
          <p><span class="text-slate-500">Upgrades:</span> ${submission.upgrades || '—'}</p>
        </div>

        <div>
          <p class="text-xs uppercase tracking-widest text-slate-500 mb-2">Blog</p>
          <p class="text-sm leading-relaxed whitespace-pre-wrap">${submission.blog_text || ''}</p>
        </div>

        <div>
          <p class="text-xs uppercase tracking-widest text-slate-500 mb-2">Media</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${renderMedia(mediaItems)}</div>
        </div>

        <div class="flex flex-wrap gap-2 pt-2 border-t border-white/10">
          <button data-action="approve" class="bg-green-600 text-white text-xs uppercase tracking-wider px-3 py-2 rounded">Approve</button>
          <button data-action="reject" class="bg-red-600 text-white text-xs uppercase tracking-wider px-3 py-2 rounded">Reject</button>
        </div>
      </article>
    `
  }

  async function loadSubmissions() {
    hideStatus()
    const selectedStatus = filterStatus.value
    const suffix = selectedStatus === 'all' ? '' : `?status=${encodeURIComponent(selectedStatus)}`

    const sessionResp = await fetch('/api/session', { credentials: 'include' })
    const sessionPayload = await sessionResp.json().catch(() => ({}))
    if (!sessionResp.ok || !sessionPayload.ok || !['owner', 'admin', 'mod'].includes(sessionPayload.role)) {
      throw new Error('You must be logged in as owner/admin/mod to access approvals.')
    }

    const response = await fetch(`/api/rig-submissions${suffix}`, { credentials: 'include' })
    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || 'Failed to load submissions.')
    }

    const rows = payload.submissions || []

    if (!rows.length) {
      listEl.innerHTML = '<p class="text-sm text-slate-500">No submissions found for this filter.</p>'
      return
    }

    listEl.innerHTML = rows.map(renderSubmissionCard).join('')
  }

  async function decide(submissionId, decision) {
    const note = prompt(`Optional note for ${decision}:`, '') || ''

    const response = await fetch(`/api/rig-submissions/${submissionId}/decision`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ decision, note }),
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || `Failed to ${decision} submission.`)
    }
  }

  listEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button) {
      return
    }

    const card = event.target.closest('[data-submission-id]')
    const submissionId = card?.getAttribute('data-submission-id')
    const action = button.getAttribute('data-action')

    if (!submissionId || !action) {
      return
    }

    button.disabled = true

    try {
      await decide(submissionId, action === 'approve' ? 'approved' : 'rejected')
      setStatus(`Submission ${submissionId} ${action}d successfully.`, 'success')
      await loadSubmissions()
    } catch (error) {
      setStatus(error.message || 'Decision failed.', 'error')
    } finally {
      button.disabled = false
    }
  })

  refreshButton.addEventListener('click', async () => {
    try {
      await loadSubmissions()
    } catch (error) {
      setStatus(error.message || 'Failed to refresh.', 'error')
    }
  })

  filterStatus.addEventListener('change', async () => {
    try {
      await loadSubmissions()
    } catch (error) {
      setStatus(error.message || 'Failed to apply filter.', 'error')
    }
  })

  loadSubmissions().catch((error) => {
    setStatus(error.message || 'Failed to load approvals.', 'error')
  })
})()
