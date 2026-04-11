(function () {
  const targets = Array.from(document.querySelectorAll('[data-hit-counter]'));
  const POLL_INTERVAL_MS = 3000;
  var lastValue = null;
  var inFlight = false;

  if (!targets.length) {
    return;
  }

  function render(value) {
    var display = Number.isFinite(value) ? value.toLocaleString('en-GB') : '--';

    targets.forEach(function (node) {
      node.textContent = display;
    });
  }

  function refreshCounter() {
    if (inFlight) {
      return;
    }

    inFlight = true;

    fetch('/api/hit-counter?ts=' + Date.now(), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'cache-control': 'no-cache',
      },
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Failed to fetch hit counter');
        }
        return response.json();
      })
      .then(function (payload) {
        var count = Number(payload && payload.count);

        if (Number.isFinite(count) && count !== lastValue) {
          lastValue = count;
          render(count);
          return;
        }

        if (!Number.isFinite(count) && lastValue === null) {
          lastValue = 0;
          render(0);
        }
      })
      .catch(function () {
        if (lastValue === null) {
          lastValue = 0;
          render(0);
        }
      })
      .finally(function () {
        inFlight = false;
      });
  }

  refreshCounter();
  window.setInterval(refreshCounter, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      refreshCounter();
    }
  });
})();
