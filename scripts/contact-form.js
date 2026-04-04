(() => {
  const form = document.getElementById('contact-form')
  const statusEl = document.getElementById('contact-submit-status')
  const submitButton = document.getElementById('contact-submit-button')

  if (!form || !statusEl || !submitButton) {
    return
  }

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

  async function submitForm(event) {
    event.preventDefault()

    const formData = new FormData(form)
    const payload = {
      name: String(formData.get('name') || '').trim(),
      email: String(formData.get('email') || '').trim(),
      subject: String(formData.get('subject') || '').trim(),
      message: String(formData.get('message') || '').trim(),
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
    } catch (error) {
      setStatus(error.message || 'Unable to send your message right now.', 'error')
    } finally {
      submitButton.disabled = false
    }
  }

  form.addEventListener('submit', submitForm)
})()
