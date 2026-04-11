(function () {
  const targets = Array.from(document.querySelectorAll('[data-hit-counter]'));

  if (!targets.length) {
    return;
  }

  fetch('/api/hit-counter', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  })
    .then(function (response) {
      if (!response.ok) {
        throw new Error('Failed to fetch hit counter');
      }
      return response.json();
    })
    .then(function (payload) {
      var count = Number(payload && payload.count);
      var display = Number.isFinite(count) ? count.toLocaleString('en-GB') : '--';

      targets.forEach(function (node) {
        node.textContent = display;
      });
    })
    .catch(function () {
      targets.forEach(function (node) {
        node.textContent = '--';
      });
    });
})();
