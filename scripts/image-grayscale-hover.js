(() => {
  const STYLE_ID = 'chrc-grayscale-hover-style'

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      .chrc-grayscale-hover {
        filter: grayscale(1);
        transition: filter 700ms ease;
      }

      .chrc-grayscale-hover:hover {
        filter: grayscale(0);
      }

      @media (hover: none) {
        .chrc-grayscale-hover {
          filter: grayscale(0.2);
        }
      }
    `
    document.head.appendChild(style)
  }

  const selectors = [
    'main img',
    'section img',
    'header img',
  ]

  const images = document.querySelectorAll(selectors.join(', '))

  images.forEach((image) => {
    if (image.closest('nav')) {
      return
    }

    if (image.dataset.noGrayscale === 'true') {
      return
    }

    image.classList.add('chrc-grayscale-hover')
  })
})()
