(() => {
  const trigger = document.querySelector('[data-account-menu-trigger]')

  if (!trigger) {
    return
  }

  const MENU_ID = 'account-menu-popover'
  const EXISTING_MENU = document.getElementById(MENU_ID)

  if (EXISTING_MENU) {
    EXISTING_MENU.remove()
  }

  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.className = 'hidden fixed z-[200] min-w-[220px] rounded-md border border-white/10 bg-[#171a1f] shadow-2xl shadow-black/40 backdrop-blur-md'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'Account menu')

  menu.innerHTML = `
    <a data-account-rig-approvals href="/pages/rig-approvals.html" role="menuitem" class="block px-4 py-3 text-sm text-slate-100 hover:bg-white/5 transition-colors hidden">
      Rig Approvals
    </a>
    <a data-account-superuser href="/pages/super-user" role="menuitem" class="block px-4 py-3 text-sm text-slate-100 hover:bg-white/5 transition-colors hidden">
      Super User Dashboard
    </a>
    <button type="button" data-account-logout class="w-full text-left px-4 py-3 text-sm text-[#ffb5a0] hover:bg-white/5 transition-colors border-t border-white/5 hidden">
      Logout
    </button>
  `

  document.body.appendChild(menu)

  const approvalsItem = menu.querySelector('[data-account-rig-approvals]')
  const superUserItem = menu.querySelector('[data-account-superuser]')
  const logoutItem = menu.querySelector('[data-account-logout]')

  if (!trigger.hasAttribute('tabindex')) {
    trigger.setAttribute('tabindex', '0')
  }

  trigger.setAttribute('role', 'button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')

  function setMenuState(isLoggedIn, role) {
    if (approvalsItem) {
      approvalsItem.href = role === 'owner' ? '/pages/super-user#rig-approvals' : '/pages/rig-approvals.html'
    }

    ensureOwnerNavLink(isLoggedIn, role)

    approvalsItem?.classList.toggle('hidden', !(isLoggedIn && ['owner', 'admin', 'mod'].includes(role)))
    superUserItem?.classList.toggle('hidden', !(isLoggedIn && role === 'owner'))
    logoutItem?.classList.toggle('hidden', !isLoggedIn)
  }

  function ensureOwnerNavLink(isLoggedIn, role) {
    const existing = document.querySelector('[data-owner-dashboard-link="true"]')

    if (!isLoggedIn || role !== 'owner') {
      existing?.remove()
      return
    }

    const navRows = Array.from(document.querySelectorAll('nav .order-3, nav .font-headline')).filter((node) =>
      node.querySelector('a[href*="meetups"]')
    )
    const navRow = navRows[0]

    if (!navRow || existing) {
      return
    }

    const link = document.createElement('a')
    link.href = window.location.pathname.startsWith('/pages/') ? 'super-user' : '/pages/super-user'
    link.className = 'font-headline tracking-tight uppercase transition-colors text-slate-400 hover:text-slate-100'
    link.dataset.ownerDashboardLink = 'true'
    link.textContent = 'Super User Dashboard'
    navRow.appendChild(link)
  }

  async function loadSessionState() {
    try {
      const response = await fetch('/api/session', {
        method: 'GET',
        credentials: 'include',
      })

      if (!response.ok) {
        const session = { ok: false }
        window.__CHRC_SESSION = session
        window.dispatchEvent(new CustomEvent('chrc:session', { detail: session }))
        setMenuState(false)
        return
      }

      const payload = await response.json()
      const session = {
        ok: Boolean(payload?.ok),
        username: payload?.username || '',
        role: payload?.role || '',
      }
      window.__CHRC_SESSION = session
      window.dispatchEvent(new CustomEvent('chrc:session', { detail: session }))
      setMenuState(session.ok, session.role)
    } catch {
      const session = { ok: false }
      window.__CHRC_SESSION = session
      window.dispatchEvent(new CustomEvent('chrc:session', { detail: session }))
      setMenuState(false)
    }
  }

  function positionMenu() {
    const rect = trigger.getBoundingClientRect()
    const menuWidth = 220
    const viewportPadding = 12
    const left = Math.max(viewportPadding, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding))
    const top = rect.bottom + 10

    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  function openMenu() {
    positionMenu()
    menu.classList.remove('hidden')
    trigger.setAttribute('aria-expanded', 'true')
  }

  function closeMenu() {
    menu.classList.add('hidden')
    trigger.setAttribute('aria-expanded', 'false')
  }

  function toggleMenu() {
    if (menu.classList.contains('hidden')) {
      openMenu()
      return
    }

    closeMenu()
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    toggleMenu()
  })

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleMenu()
    }

    if (event.key === 'Escape') {
      closeMenu()
    }
  })

  menu.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-account-logout]')

    if (!target) {
      return
    }

    event.preventDefault()

    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // Ignore network errors and continue redirect.
    }

    window.location.href = '/index.html'
  })

  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target) && !trigger.contains(event.target)) {
      closeMenu()
    }
  })

  window.addEventListener('resize', closeMenu)
  window.addEventListener('scroll', closeMenu, true)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu()
    }
  })

  setMenuState(false, '')
  loadSessionState()
})()
