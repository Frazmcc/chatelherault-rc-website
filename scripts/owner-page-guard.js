(() => {
  async function enforceOwner() {
    try {
      const response = await fetch('/api/session', { credentials: 'include' })
      if (!response.ok) {
        window.location.replace('/crc-portal')
        return
      }

      const payload = await response.json()
      if (!payload?.ok || payload.role !== 'owner') {
        window.location.replace('/index.html')
        return
      }

      document.documentElement.classList.remove('owner-guard-hidden')
    } catch {
      window.location.replace('/crc-portal')
    }
  }

  document.documentElement.classList.add('owner-guard-hidden')
  enforceOwner()
})()
