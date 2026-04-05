(() => {
  let trigger = null
  let sessionState = { ok: false, username: '', role: '' }

  function getNavControlsContainer() {
    const explicit = document.querySelector('nav [data-account-controls]')
    if (explicit) {
      return explicit
    }

    const candidates = Array.from(document.querySelectorAll('nav .flex.items-center'))
    const withSpacing = candidates.find((node) => /space-x-/.test(node.className))

    if (withSpacing) {
      return withSpacing
    }

    const navInner = document.querySelector('nav > div')
    if (!navInner) {
      return null
    }

    const created = document.createElement('div')
    created.className = 'flex items-center space-x-4'
    created.setAttribute('data-account-controls', 'true')
    navInner.appendChild(created)
    return created
  }

  function ensureTrigger(container) {
    const existing = container.querySelector('[data-account-menu-trigger]')
    if (existing) {
      return existing
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-account-menu-trigger', 'true')
    button.className = 'inline-flex items-center gap-2 rounded-sm border border-white/15 bg-black/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-200 hover:border-white/30 hover:bg-black/45 transition-colors'
    button.innerHTML = `
      <span data-account-session-dot class="inline-block h-2 w-2 rounded-full bg-slate-500"></span>
      <span data-account-session-label>Login</span>
    `
    container.appendChild(button)
    return button
  }

  function ensureOwnerQuickLink(container, isLoggedIn, role) {
    let quickLink = container.querySelector('[data-owner-dashboard-quick]')

    if (!quickLink) {
      quickLink = document.createElement('a')
      quickLink.href = '/pages/super-user'
      quickLink.className = 'hidden font-headline tracking-tight uppercase text-[10px] text-accent hover:text-[#f59e0b] transition-colors'
      quickLink.setAttribute('data-owner-dashboard-quick', 'true')
      quickLink.textContent = 'Super User Dashboard'
      container.appendChild(quickLink)
    }

    quickLink.classList.toggle('hidden', !(isLoggedIn && role === 'owner'))
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

  const controlsContainer = getNavControlsContainer()

  if (!controlsContainer) {
    return
  }

  trigger = ensureTrigger(controlsContainer)
  const triggerLabel = trigger.querySelector('[data-account-session-label]')
  const triggerDot = trigger.querySelector('[data-account-session-dot]')

  if (!trigger.hasAttribute('tabindex')) {
    trigger.setAttribute('tabindex', '0')
  }

  trigger.setAttribute('role', 'button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')

  function setMenuState(isLoggedIn, role, username = '') {
    if (approvalsItem) {
      approvalsItem.href = role === 'owner' ? '/pages/super-user#rig-approvals' : '/pages/rig-approvals.html'
    }

    ensureOwnerQuickLink(controlsContainer, isLoggedIn, role)

    if (triggerLabel) {
      triggerLabel.textContent = isLoggedIn ? `${username || 'Member'} (${role})` : 'Login'
    }

    if (triggerDot) {
      triggerDot.className = `inline-block h-2 w-2 rounded-full ${isLoggedIn ? 'bg-emerald-400' : 'bg-slate-500'}`
    }

    approvalsItem?.classList.toggle('hidden', !(isLoggedIn && ['owner', 'admin', 'mod'].includes(role)))
    superUserItem?.classList.toggle('hidden', !(isLoggedIn && role === 'owner'))
    logoutItem?.classList.toggle('hidden', !isLoggedIn)

    sessionState = {
      ok: Boolean(isLoggedIn),
      role: role || '',
      username: username || '',
    }
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
        setMenuState(false, '', '')
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
      setMenuState(session.ok, session.role, session.username)
    } catch {
      const session = { ok: false }
      window.__CHRC_SESSION = session
      window.dispatchEvent(new CustomEvent('chrc:session', { detail: session }))
      setMenuState(false, '', '')
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

    if (!sessionState.ok) {
      window.location.href = '/admin/login'
      return
    }

    toggleMenu()
  })

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!sessionState.ok) {
        window.location.href = '/admin/login'
        return
      }

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

  setMenuState(false, '', '')
  loadSessionState()
})()
