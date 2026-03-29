(() => {
  const listEl = document.getElementById('members-rigs-list')
  const statusEl = document.getElementById('members-rigs-status')

  if (!listEl || !statusEl) {
    return
  }

  function setStatus(message, tone) {
    statusEl.textContent = message
    statusEl.className = 'text-sm rounded border px-3 py-2 mb-6'

    if (tone === 'error') {
      statusEl.classList.add('border-red-400/40', 'bg-red-900/20', 'text-red-200')
    } else {
      statusEl.classList.add('border-white/20', 'bg-white/5', 'text-slate-200')
    }

    statusEl.classList.remove('hidden')
  }

  function renderMedia(mediaItems) {
    if (!Array.isArray(mediaItems) || !mediaItems.length) {
      return '<p class="text-xs text-slate-500">No media attached.</p>'
    }

    return mediaItems
      .map((item) => {
        if (!item || !item.dataUrl) {
          return ''
        }

        if (String(item.type).startsWith('image/')) {
          return `<img src="${item.dataUrl}" alt="Rig media" class="rounded border border-white/10 w-full max-h-64 object-cover"/>`
        }

        if (String(item.type).startsWith('video/')) {
          return `<video controls src="${item.dataUrl}" class="rounded border border-white/10 w-full max-h-64"></video>`
        }

        return ''
      })
      .join('')
  }

  function renderCard(rig) {
    let mediaItems = []

    try {
      mediaItems = JSON.parse(rig.media_items || '[]')
    } catch {
      mediaItems = []
    }

    return `
      <article class="bg-surface border border-white/10 rounded-lg p-5 space-y-4">
        <div>
          <h2 class="font-headline text-2xl font-bold">${rig.owner_name}</h2>
          <p class="text-sm text-slate-300">${rig.chassis_model}</p>
          <p class="text-xs text-slate-500 mt-1">Approved Build</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <p><span class="text-slate-500">Battery:</span> ${rig.battery || '—'}</p>
          <p><span class="text-slate-500">Upgrades:</span> ${rig.upgrades || '—'}</p>
        </div>

        <div>
          <p class="text-xs uppercase tracking-widest text-slate-500 mb-2">Build Blog</p>
          <p class="text-sm leading-relaxed whitespace-pre-wrap">${rig.blog_text || ''}</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${renderMedia(mediaItems)}</div>
      </article>
    `
  }

  async function loadMembersRigs() {
    const response = await fetch('/api/rig-submissions-public')
    const payload = await response.json().catch(() => ({}))

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || 'Failed to load approved rigs.')
    }

    const rows = payload.rigs || []

    if (!rows.length) {
      listEl.innerHTML = '<p class="text-sm text-slate-500">No approved rigs yet. Check back soon.</p>'
      return
    }

    listEl.innerHTML = rows.map(renderCard).join('')
  }

  loadMembersRigs().catch((error) => {
    setStatus(error.message || 'Could not load members rigs.', 'error')
  })
})()
