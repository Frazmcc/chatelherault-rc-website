(() => {
  const ALLOWED_PATHS = new Set([
    '/index.html',
    '/pages/meetups.html',
    '/pages/media.html',
    '/pages/spotlight.html',
    '/pages/contact.html',
    '/pages/super-user',
    '/pages/super-user.html',
    '/admin/login',
    '/admin/login.html',
    '/crc-portal',
  ])

  function normalizeNavLinks() {
    const links = document.querySelectorAll('a[href]')

    links.forEach((link) => {
      const rawHref = link.getAttribute('href') || ''

      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
        return
      }

      if (rawHref.startsWith('http://') || rawHref.startsWith('https://') || rawHref.startsWith('javascript:')) {
        return
      }

      let resolved
      try {
        resolved = new URL(rawHref, window.location.href)
      } catch {
        return
      }

      if (ALLOWED_PATHS.has(resolved.pathname)) {
        link.setAttribute('href', resolved.pathname)
      }
    })
  }

  function lockAddressBar() {
    if (window.location.pathname !== '/') {
      history.replaceState({}, '', '/')
    }
  }

  document.title = 'Chatelherault RC'
  normalizeNavLinks()
  lockAddressBar()
})()
