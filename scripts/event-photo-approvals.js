(() => {
  const listEl = document.getElementById('event-photo-approvals-list')
  const statusEl = document.getElementById('event-photo-approvals-status')
  const refreshButton = document.getElementById('event-photo-refresh')
  const filterStatus = document.getElementById('event-photo-filter-status')
  const selectAllButton = document.getElementById('event-photo-select-all')
  const clearSelectionButton = document.getElementById('event-photo-clear-selection')
  const approveSelectedButton = document.getElementById('event-photo-approve-selected')
  const rejectSelectedButton = document.getElementById('event-photo-reject-selected')
  const approveAllButton = document.getElementById('event-photo-approve-all')
  const rejectAllButton = document.getElementById('event-photo-reject-all')
  const selectionCountEl = document.getElementById('event-photo-selection-count')

  if (
    !listEl ||
    !statusEl ||
    !refreshButton ||
    !filterStatus ||
    !selectAllButton ||
    !clearSelectionButton ||
    !approveSelectedButton ||
    !rejectSelectedButton ||
    !approveAllButton ||
    !rejectAllButton ||
    !selectionCountEl
  ) {
    return
  }

  const selectedIds = new Set()
  let currentRows = []

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

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function safeMediaUrl(value) {
    const candidate = String(value || '').trim()
    return /^data:image\//i.test(candidate) ? candidate : ''
  }

  function getSelectionIds() {
    return Array.from(selectedIds).filter((id) => Number.isFinite(id) && id > 0)
  }

  function updateSelectionCount() {
    selectionCountEl.textContent = `${getSelectionIds().length} selected`
  }

  function clearSelection() {
    selectedIds.clear()
    listEl.querySelectorAll('input[data-select-id]').forEach((input) => {
      input.checked = false
    })
    updateSelectionCount()
  }

  function renderMedia(mediaItems) {
    if (!Array.isArray(mediaItems) || !mediaItems.length) {
      return '<p class="text-xs text-slate-500">No images uploaded.</p>'
    }

    return mediaItems
      .map((item) => {
        const safeSrc = safeMediaUrl(item?.dataUrl)
        if (!safeSrc) {
          return ''
        }

        return `<img src="${escapeHtml(safeSrc)}" alt="Event upload" class="rounded border border-white/10 max-h-56 object-cover"/>`
      })
      .join('')
  }

  function renderSubmissionCard(submission) {
    const status = String(submission.status || '').toLowerCase()
    const mediaItems = (() => {
      try {
        return JSON.parse(submission.media_items || '[]')
      } catch {
        return []
      }
    })()

    const actionButtons = (() => {
      if (status === 'approved') {
        return `<button data-action="reject" class="bg-red-600 text-white text-xs uppercase tracking-wider px-3 py-2 rounded">Reject</button>`
      }

      if (status === 'rejected') {
        return `<button data-action="approve" class="bg-green-600 text-white text-xs uppercase tracking-wider px-3 py-2 rounded">Approve</button>`
      }

      return `
        <button data-action="approve" class="bg-green-600 text-white text-xs uppercase tracking-wider px-3 py-2 rounded">Approve</button>
        <button data-action="reject" class="bg-red-600 text-white text-xs uppercase tracking-wider px-3 py-2 rounded">Reject</button>
      `
    })()

    return `
      <article class="bg-surface border border-white/10 rounded-lg p-5 space-y-4" data-submission-id="${submission.id}">
        <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div class="flex items-start gap-3">
            <label class="mt-1">
              <input data-select-id="${submission.id}" type="checkbox" class="h-4 w-4 rounded border-white/20 bg-[#0f1114]" ${selectedIds.has(Number(submission.id)) ? 'checked' : ''}/>
            </label>
            <div>
              <h2 class="font-headline text-xl font-bold">${escapeHtml(submission.submitter_name || 'Anonymous uploader')}</h2>
              <p class="text-xs text-slate-500 mt-1">Submitted: ${escapeHtml(submission.submitted_at || 'Unknown')}</p>
              <p class="text-xs text-slate-400 mt-1">${escapeHtml(submission.note || 'No note provided.')}</p>
            </div>
          </div>
          <div class="text-xs uppercase tracking-widest px-2 py-1 rounded border border-white/20">${escapeHtml(submission.status)}</div>
        </div>

        <div>
          <p class="text-xs uppercase tracking-widest text-slate-500 mb-2">Uploaded Images</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${renderMedia(mediaItems)}</div>
        </div>

        <div class="flex flex-wrap gap-2 pt-2 border-t border-white/10">
          ${actionButtons}
        </div>
      </article>
    `
  }

  async function loadSubmissions() {
    hideStatus()

    const selectedStatus = filterStatus.value
    const suffix = selectedStatus === 'all' ? '' : `?status=${encodeURIComponent(selectedStatus)}`
    const response = await fetch(`/api/event-photo-submissions${suffix}`, { credentials: 'include' })
    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || 'Failed to load event photo submissions.')
    }

    currentRows = payload.submissions || []

    if (!currentRows.length) {
      listEl.innerHTML = '<p class="text-sm text-slate-500">No submissions found for this filter.</p>'
      clearSelection()
      return
    }

    const activeIds = new Set(currentRows.map((row) => Number(row.id)))
    Array.from(selectedIds).forEach((id) => {
      if (!activeIds.has(id)) {
        selectedIds.delete(id)
      }
    })

    listEl.innerHTML = currentRows.map(renderSubmissionCard).join('')
    updateSelectionCount()
  }

  async function runDecision(submissionId, decision, actionLabel) {
    const note = prompt(`Optional note for ${decision}:`, '') || ''

    const response = await fetch(`/api/event-photo-submissions/${submissionId}/decision`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ decision, note }),
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || `Failed to ${actionLabel || decision} submission.`)
    }
  }

  async function runBatchDecision(decision, ids, scopeStatus) {
    const note = prompt(`Optional note for ${decision}:`, '') || ''
    const response = await fetch('/api/event-photo-submissions/batch-decision', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ decision, ids, scopeStatus, note }),
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || 'Batch action failed.')
    }

    return payload.summary || { total: 0, changed: 0, failed: 0, skipped: 0 }
  }

  listEl.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-select-id]')
    if (!checkbox) {
      return
    }

    const id = Number.parseInt(String(checkbox.getAttribute('data-select-id')), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return
    }

    if (checkbox.checked) {
      selectedIds.add(id)
    } else {
      selectedIds.delete(id)
    }

    updateSelectionCount()
  })

  listEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button) {
      return
    }

    const card = event.target.closest('[data-submission-id]')
    const submissionId = Number.parseInt(String(card?.getAttribute('data-submission-id') || ''), 10)
    const action = String(button.getAttribute('data-action') || '')

    if (!Number.isFinite(submissionId) || !action) {
      return
    }

    button.disabled = true

    try {
      const decision = action === 'approve' ? 'approved' : 'rejected'
      await runDecision(submissionId, decision, action)
      setStatus(`Submission ${submissionId} ${action}d successfully.`, 'success')
      await loadSubmissions()
    } catch (error) {
      setStatus(error.message || 'Decision failed.', 'error')
    } finally {
      button.disabled = false
    }
  })

  selectAllButton.addEventListener('click', () => {
    currentRows.forEach((row) => {
      selectedIds.add(Number(row.id))
    })

    listEl.querySelectorAll('input[data-select-id]').forEach((input) => {
      input.checked = true
    })

    updateSelectionCount()
  })

  clearSelectionButton.addEventListener('click', () => {
    clearSelection()
  })

  approveSelectedButton.addEventListener('click', async () => {
    const ids = getSelectionIds()
    if (!ids.length) {
      setStatus('Select at least one submission first.', 'error')
      return
    }

    if (!window.confirm(`Approve ${ids.length} selected submissions?`)) {
      return
    }

    try {
      const summary = await runBatchDecision('approved', ids)
      clearSelection()
      await loadSubmissions()
      setStatus(`Batch approve complete: ${summary.changed} changed, ${summary.skipped} skipped, ${summary.failed} failed.`, 'success')
    } catch (error) {
      setStatus(error.message || 'Batch approve failed.', 'error')
    }
  })

  rejectSelectedButton.addEventListener('click', async () => {
    const ids = getSelectionIds()
    if (!ids.length) {
      setStatus('Select at least one submission first.', 'error')
      return
    }

    if (!window.confirm(`Reject ${ids.length} selected submissions?`)) {
      return
    }

    try {
      const summary = await runBatchDecision('rejected', ids)
      clearSelection()
      await loadSubmissions()
      setStatus(`Batch reject complete: ${summary.changed} changed, ${summary.skipped} skipped, ${summary.failed} failed.`, 'success')
    } catch (error) {
      setStatus(error.message || 'Batch reject failed.', 'error')
    }
  })

  approveAllButton.addEventListener('click', async () => {
    const scopeStatus = filterStatus.value
    if (!window.confirm(`Approve all submissions in filter: ${scopeStatus}?`)) {
      return
    }

    try {
      const summary = await runBatchDecision('approved', [], scopeStatus)
      clearSelection()
      await loadSubmissions()
      setStatus(`Approve all complete: ${summary.changed} changed, ${summary.skipped} skipped, ${summary.failed} failed.`, 'success')
    } catch (error) {
      setStatus(error.message || 'Approve all failed.', 'error')
    }
  })

  rejectAllButton.addEventListener('click', async () => {
    const scopeStatus = filterStatus.value
    if (!window.confirm(`Reject all submissions in filter: ${scopeStatus}?`)) {
      return
    }

    try {
      const summary = await runBatchDecision('rejected', [], scopeStatus)
      clearSelection()
      await loadSubmissions()
      setStatus(`Reject all complete: ${summary.changed} changed, ${summary.skipped} skipped, ${summary.failed} failed.`, 'success')
    } catch (error) {
      setStatus(error.message || 'Reject all failed.', 'error')
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
    clearSelection()
    try {
      await loadSubmissions()
    } catch (error) {
      setStatus(error.message || 'Failed to apply filter.', 'error')
    }
  })

  loadSubmissions().catch((error) => {
    setStatus(error.message || 'Failed to load event photo approvals.', 'error')
  })
})()
