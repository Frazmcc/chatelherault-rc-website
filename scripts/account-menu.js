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
    <a href="/admin/index.html" role="menuitem" class="block px-4 py-3 text-sm text-slate-100 hover:bg-white/5 transition-colors">
      Profile
    </a>
    <a href="/admin/index.html#account" role="menuitem" class="block px-4 py-3 text-sm text-slate-300 hover:bg-white/5 transition-colors border-t border-white/5">
      Account Details
    </a>
    <button type="button" data-account-logout class="w-full text-left px-4 py-3 text-sm text-[#ffb5a0] hover:bg-white/5 transition-colors border-t border-white/5">
      Logout
    </button>
  `

  document.body.appendChild(menu)

  if (!trigger.hasAttribute('tabindex')) {
    trigger.setAttribute('tabindex', '0')
  }

  trigger.setAttribute('role', 'button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')

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
})()
