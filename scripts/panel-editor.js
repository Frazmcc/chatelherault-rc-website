(() => {
  const ALLOWED_ROLES = new Set(['owner', 'admin', 'mod'])

  function getPageId() {
    const path = window.location.pathname.toLowerCase()
    if (path === '/' || path === '/index.html') return 'home'
    if (path.endsWith('/pages/meetups.html')) return 'meetups'
    if (path.endsWith('/pages/media.html')) return 'media'
    if (path.endsWith('/pages/spotlight.html')) return 'spotlight'
    if (path.endsWith('/pages/contact.html')) return 'contact'
    return path.replace(/[^a-z0-9]+/g, '_')
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c])
  }

  function isValidUrl(url) {
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  }

  function findPanels() {
    const rootCandidates = document.querySelectorAll('body > header, main > header, main > section')
    const panels = []

    rootCandidates.forEach((element) => {
      if (element.closest('nav')) {
        return
      }

      if (element.tagName === 'HEADER' && element.closest('nav')) {
        return
      }

      panels.push(element)
    })

    return panels
  }

  function ensureSuperUserTab(session) {
    if (!session?.ok || session.role !== 'owner') {
      return
    }

    const navRows = Array.from(document.querySelectorAll('nav .order-3, nav .font-headline')).filter((node) =>
      node.querySelector('a[href*="meetups"]')
    )

    const navRow = navRows[0]

    if (!navRow || navRow.querySelector('[data-super-user-link]')) {
      return
    }

    const base = window.location.pathname.startsWith('/pages/') ? '../pages/super-user' : 'pages/super-user'
    const link = document.createElement('a')
    link.href = base
    link.className = 'font-headline tracking-tight uppercase transition-colors text-slate-400 hover:text-slate-100'
    link.dataset.superUserLink = 'true'
    link.textContent = 'Super User'
    navRow.appendChild(link)
  }

  function createEditorModal() {
    const modal = document.createElement('div')
    modal.className = 'hidden fixed inset-0 z-[240] bg-black/60 px-4 py-6 overflow-y-auto'
    modal.innerHTML = `
      <div class="max-w-3xl mx-auto bg-[#15181d] border border-white/10 rounded-lg shadow-2xl">
        <div class="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-4">
          <h3 class="text-slate-100 font-bold uppercase tracking-widest text-xs">Panel Editor</h3>
          <button type="button" data-panel-close class="text-slate-400 hover:text-slate-100">✕</button>
        </div>
        <div class="p-5 space-y-4">
          <div>
            <label class="block text-[10px] uppercase tracking-widest text-slate-500 mb-1">Panel HTML</label>
            <textarea data-panel-html rows="8" class="w-full bg-[#0f1114] border border-white/10 rounded-md px-3 py-2 text-sm text-slate-200"></textarea>
          </div>
          <div>
            <label class="block text-[10px] uppercase tracking-widest text-slate-500 mb-1">Primary Media URL (optional)</label>
            <input data-panel-media type="url" class="w-full bg-[#0f1114] border border-white/10 rounded-md px-3 py-2 text-sm text-slate-200" placeholder="https://..." />
          </div>
          <div data-panel-status class="hidden text-xs text-[#ffb4ab]"></div>
        </div>
        <div class="px-5 py-4 border-t border-white/10 flex flex-wrap gap-2 justify-end">
          <button type="button" data-media-add class="px-3 py-2 text-[10px] uppercase tracking-widest font-bold text-slate-100 bg-slate-700/60 rounded">Add Media</button>
          <button type="button" data-media-remove class="px-3 py-2 text-[10px] uppercase tracking-widest font-bold text-slate-200 bg-slate-800 rounded">Remove Media</button>
          <button type="button" data-panel-save class="px-3 py-2 text-[10px] uppercase tracking-widest font-bold text-white bg-[#d97706] rounded">Save Panel</button>
        </div>
      </div>
    `
    document.body.appendChild(modal)
    return modal
  }

  async function init(session) {
    if (!session?.ok || !ALLOWED_ROLES.has(session.role)) {
      return
    }

    ensureSuperUserTab(session)

    const pageId = getPageId()
    const panels = findPanels()
    if (!panels.length) {
      return
    }

    const modal = createEditorModal()
    const htmlField = modal.querySelector('[data-panel-html]')
    const mediaField = modal.querySelector('[data-panel-media]')
    const status = modal.querySelector('[data-panel-status]')

    const closeModal = () => {
      modal.classList.add('hidden')
      status.classList.add('hidden')
      status.textContent = ''
    }

    modal.querySelector('[data-panel-close]').addEventListener('click', closeModal)
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal()
      }
    })

    const storedByKey = {}

    try {
      const response = await fetch('/api/content', { credentials: 'include' })
      if (response.ok) {
        const payload = await response.json()
        for (const entry of payload.content || []) {
          storedByKey[`${entry.page}::${entry.key}`] = entry.value
        }
      }
    } catch {
      // Ignore read errors here; save still works when online.
    }

    function applyPanelOverrides(panel, panelId) {
      const htmlKey = `${pageId}::panel-${panelId}-html`
      const mediaKey = `${pageId}::panel-${panelId}-media`
      const storedHtml = storedByKey[`${pageId}::panel-${panelId}-html`] || storedByKey[htmlKey]
      const storedMedia = storedByKey[`${pageId}::panel-${panelId}-media`] || storedByKey[mediaKey]

      if (typeof storedHtml === 'string' && storedHtml.length > 0) {
        panel.innerHTML = storedHtml
      }

      if (typeof storedMedia === 'string' && storedMedia.length > 0) {
        const target = panel.querySelector('img, iframe, video source, video')
        if (target) {
          if (target.tagName.toLowerCase() === 'source') {
            target.setAttribute('src', storedMedia)
            target.parentElement?.load?.()
          } else {
            target.setAttribute('src', storedMedia)
          }
        }
      }
    }

    let activePanel = null
    let activePanelId = null

    async function saveContentValue(key, value) {
      const response = await fetch('/api/content', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          page: pageId,
          key,
          value,
        }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.message || 'Failed to save content.')
      }
    }

    async function addMediaToLibrary(url) {
      const response = await fetch('/api/media', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `${pageId} panel media`,
          url,
          type: /\.(mp4|webm|mov)(\?|$)/i.test(url) ? 'video' : 'image',
        }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.message || 'Failed to add media.')
      }
    }

    async function removeMediaFromLibrary(url) {
      const response = await fetch('/api/media', { credentials: 'include' })
      if (!response.ok) {
        throw new Error('Unable to query media library.')
      }

      const payload = await response.json()
      const target = (payload.media || []).find((item) => String(item.url || '') === url)

      if (!target) {
        throw new Error('Media URL not found in library.')
      }

      const deleteResponse = await fetch(`/api/media/${target.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })

      if (!deleteResponse.ok) {
        throw new Error('Failed to remove media.')
      }
    }

    modal.querySelector('[data-panel-save]').addEventListener('click', async () => {
      if (!activePanel || activePanelId === null) {
        return
      }

      const htmlValue = htmlField.value
      const mediaValue = mediaField.value.trim()
      status.classList.add('hidden')

      try {
        await saveContentValue(`panel-${activePanelId}-html`, htmlValue)

        if (mediaValue) {
          if (!isValidUrl(mediaValue)) {
            throw new Error('Please provide a valid media URL.')
          }
          await saveContentValue(`panel-${activePanelId}-media`, mediaValue)
        }

        activePanel.innerHTML = htmlValue
        if (mediaValue) {
          const target = activePanel.querySelector('img, iframe, video source, video')
          if (target) {
            if (target.tagName.toLowerCase() === 'source') {
              target.setAttribute('src', mediaValue)
              target.parentElement?.load?.()
            } else {
              target.setAttribute('src', mediaValue)
            }
          }
        }

        closeModal()
        init(session)
      } catch (error) {
        status.textContent = error.message || 'Failed to save panel.'
        status.classList.remove('hidden')
      }
    })

    modal.querySelector('[data-media-add]').addEventListener('click', async () => {
      const url = mediaField.value.trim()
      status.classList.add('hidden')

      try {
        if (!isValidUrl(url)) {
          throw new Error('Provide a valid URL to add media.')
        }
        await addMediaToLibrary(url)
        status.textContent = 'Media added.'
        status.classList.remove('hidden')
      } catch (error) {
        status.textContent = error.message || 'Unable to add media.'
        status.classList.remove('hidden')
      }
    })

    modal.querySelector('[data-media-remove]').addEventListener('click', async () => {
      const url = mediaField.value.trim()
      status.classList.add('hidden')

      try {
        if (!isValidUrl(url)) {
          throw new Error('Provide a valid URL to remove media.')
        }
        await removeMediaFromLibrary(url)
        status.textContent = 'Media removed.'
        status.classList.remove('hidden')
      } catch (error) {
        status.textContent = error.message || 'Unable to remove media.'
        status.classList.remove('hidden')
      }
    })

    panels.forEach((panel, index) => {
      const panelId = index + 1
      panel.dataset.editPanelId = String(panelId)

      applyPanelOverrides(panel, panelId)

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'absolute top-2 right-2 z-[180] rounded-sm border border-white/20 bg-black/40 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-200 opacity-35 hover:opacity-100 transition-opacity'
      button.innerHTML = 'edit'
      button.title = 'Edit this panel'

      if (getComputedStyle(panel).position === 'static') {
        panel.style.position = 'relative'
      }

      panel.appendChild(button)

      button.addEventListener('click', () => {
        activePanel = panel
        activePanelId = panelId
        htmlField.value = panel.innerHTML

        const target = panel.querySelector('img, iframe, video source, video')
        mediaField.value = target ? (target.getAttribute('src') || '') : ''

        status.classList.add('hidden')
        modal.classList.remove('hidden')
      })
    })

    const badge = document.createElement('div')
    badge.className = 'fixed bottom-4 left-4 z-[181] rounded-sm border border-[#d97706]/40 bg-[#121416]/80 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[#d97706]'
    badge.textContent = `Edit Enabled: ${escapeHtml(session.role)}`
    document.body.appendChild(badge)
  }

  function bootstrap() {
    const existing = window.__CHRC_SESSION
    if (existing && typeof existing.ok === 'boolean') {
      init(existing)
      return
    }

    const listener = (event) => {
      window.removeEventListener('chrc:session', listener)
      init(event.detail || { ok: false })
    }

    window.addEventListener('chrc:session', listener)

    setTimeout(() => {
      const fallback = window.__CHRC_SESSION
      if (fallback && typeof fallback.ok === 'boolean') {
        window.removeEventListener('chrc:session', listener)
        init(fallback)
      }
    }, 2000)
  }

  bootstrap()
})()
