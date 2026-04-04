(() => {
  const form = document.getElementById('contact-form')
  const statusEl = document.getElementById('contact-submit-status')
  const submitButton = document.getElementById('contact-submit-button')
  const turnstileContainer = document.getElementById('turnstile-container')
  let turnstileToken = ''
  let turnstileWidgetId = null

  if (!form || !statusEl || !submitButton) {
    return
  }

  submitButton.disabled = true

  function setStatus(message, tone) {
    statusEl.textContent = message
    statusEl.className = 'md:col-span-2 text-sm rounded border px-3 py-2'

    if (tone === 'error') {
      statusEl.classList.add('border-red-400/40', 'bg-red-900/20', 'text-red-200')
    } else {
      statusEl.classList.add('border-white/20', 'bg-white/5', 'text-slate-200')
    }

    statusEl.classList.remove('hidden')
  }

  async function setupTurnstile() {
    if (!turnstileContainer) {
      return
    }

    try {
      const response = await fetch('/api/contact-config')
      const config = await response.json().catch(() => ({}))
      const siteKey = String(config?.turnstileSiteKey || '').trim()
      const turnstileEnabled = Boolean(config?.turnstileEnabled)

      if (!turnstileEnabled || !siteKey) {
        setStatus('Security verification is not configured yet. Please try again shortly.', 'error')
        return
      }

      if (!window.turnstile) {
        setStatus('Unable to load security verification. Please refresh and try again.', 'error')
        return
      }

      turnstileWidgetId = window.turnstile.render(turnstileContainer, {
        sitekey: siteKey,
        theme: 'dark',
        callback(token) {
          turnstileToken = token || ''
          submitButton.disabled = !turnstileToken
        },
        'expired-callback'() {
          turnstileToken = ''
          submitButton.disabled = true
        },
        'error-callback'() {
          turnstileToken = ''
          submitButton.disabled = true
          setStatus('Security verification failed. Please try again.', 'error')
        },
      })
    } catch {
      setStatus('Unable to initialize security verification. Please try again later.', 'error')
    }
  }

  async function submitForm(event) {
    event.preventDefault()

    const formData = new FormData(form)
    const payload = {
      name: String(formData.get('name') || '').trim(),
      email: String(formData.get('email') || '').trim(),
      subject: String(formData.get('subject') || '').trim(),
      message: String(formData.get('message') || '').trim(),
      turnstileToken,
    }

    if (!turnstileToken) {
      setStatus('Please complete the security verification before sending.', 'error')
      return
    }

    submitButton.disabled = true

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Unable to send your message right now.')
      }

      form.reset()
      setStatus('Thank you. Your message has been sent.', 'ok')
      turnstileToken = ''

      if (window.turnstile && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId)
      }
    } catch (error) {
      setStatus(error.message || 'Unable to send your message right now.', 'error')
    } finally {
      submitButton.disabled = !turnstileToken
    }
  }

  form.addEventListener('submit', submitForm)
  setupTurnstile()
})()
