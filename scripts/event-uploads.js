(() => {
  const form = document.getElementById('event-photo-upload-form')
  const statusEl = document.getElementById('event-photo-submit-status')
  const submitButton = document.getElementById('event-photo-submit-button')
  const photoInput = document.getElementById('event-photo-input')
  const turnstileWrap = document.getElementById('event-photo-turnstile-wrap')
  const turnstileContainer = document.getElementById('event-photo-turnstile')

  if (!form || !statusEl || !submitButton || !photoInput || !turnstileWrap || !turnstileContainer) {
    return
  }

  const MAX_FILES = 10
  const MAX_DIMENSION = 2560
  let turnstileWidgetId = null

  function setStatus(message, tone) {
    statusEl.textContent = message
    statusEl.className = 'text-sm rounded border px-3 py-2'

    if (tone === 'error') {
      statusEl.classList.add('border-red-400/40', 'bg-red-900/20', 'text-red-200')
    } else if (tone === 'success') {
      statusEl.classList.add('border-green-400/40', 'bg-green-900/20', 'text-green-200')
    } else {
      statusEl.classList.add('border-white/20', 'bg-white/5', 'text-slate-200')
    }

    statusEl.classList.remove('hidden')
  }

  function getTurnstileToken() {
    if (turnstileWidgetId === null || !window.turnstile) {
      return ''
    }

    return String(window.turnstile.getResponse(turnstileWidgetId) || '')
  }

  function fileWithExtension(file, ext, type, blob) {
    const base = file.name.replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.${ext}`, { type, lastModified: Date.now() })
  }

  async function optimizeImageFile(file) {
    const bitmap = await createImageBitmap(file)
    let width = bitmap.width
    let height = bitmap.height

    if (Math.max(width, height) > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, width, height)

    const webpBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.84))

    if (!webpBlob) {
      return file
    }

    if (webpBlob.size < file.size) {
      return fileWithExtension(file, 'webp', 'image/webp', webpBlob)
    }

    return file
  }

  async function optimizeFiles(files) {
    const optimized = []

    for (const file of files) {
      optimized.push(await optimizeImageFile(file))
    }

    return optimized
  }

  async function setupTurnstile() {
    try {
      const response = await fetch('/api/contact-config')
      const payload = await response.json().catch(() => ({}))

      if (!response.ok || !payload.ok || !payload.turnstileEnabled || !payload.turnstileSiteKey) {
        return
      }

      if (!window.turnstile || typeof window.turnstile.render !== 'function') {
        return
      }

      turnstileWrap.classList.remove('hidden')
      turnstileWidgetId = window.turnstile.render('#event-photo-turnstile', {
        sitekey: payload.turnstileSiteKey,
        theme: 'dark',
      })
    } catch {
      // Do not block uploads when challenge setup fails.
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    submitButton.disabled = true
    setStatus('Optimizing images and submitting...', 'info')

    try {
      const files = Array.from(photoInput.files || [])
      if (!files.length) {
        throw new Error('Please choose at least one image.')
      }

      if (files.length > MAX_FILES) {
        throw new Error(`Maximum ${MAX_FILES} images per submission.`)
      }

      const optimized = await optimizeFiles(files)

      const payload = new FormData()
      payload.set('name', String(form.name.value || '').trim())
      payload.set('note', String(form.note.value || '').trim())
      payload.set('website', String(form.website.value || '').trim())
      payload.set('turnstileToken', getTurnstileToken())

      optimized.forEach((file) => {
        payload.append('photos', file)
      })

      const response = await fetch('/api/event-photo-submissions', {
        method: 'POST',
        body: payload,
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Submission failed.')
      }

      form.reset()
      setStatus('Thanks. Your images are now in quarantine pending admin approval.', 'success')

      if (turnstileWidgetId !== null && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId)
      }
    } catch (error) {
      setStatus(error.message || 'Failed to submit images.', 'error')
    } finally {
      submitButton.disabled = false
    }
  })

  if (window.turnstile) {
    setupTurnstile()
  } else {
    window.addEventListener('load', () => {
      setupTurnstile()
    })
  }
})()
