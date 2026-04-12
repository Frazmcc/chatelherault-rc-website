(() => {
  const path = window.location.pathname.toLowerCase()

  if (path === '/crc-portal') {
    return
  }

  window.location.replace('/index.html')
})()
