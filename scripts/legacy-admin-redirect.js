(() => {
  const path = window.location.pathname.toLowerCase()

  if (path === '/admin/login' || path === '/admin/login.html') {
    return
  }

  if (path === '/admin/root-login' || path === '/admin/root-login.html') {
    window.location.replace('/admin/login')
    return
  }

  window.location.replace('/index.html')
})()
