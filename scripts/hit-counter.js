(function () {
  const targets = Array.from(document.querySelectorAll('[data-hit-counter]'));
  const STORAGE_KEY = 'chrc-visit-session';
  const DEFAULT_SESSION_WINDOW_MS = 30 * 60 * 1000;

  if (!targets.length) {
    return;
  }

  function render(value) {
    const display = Number.isFinite(value) ? value.toLocaleString('en-GB') : '--';

    targets.forEach(function (node) {
      node.textContent = display;
    });
  }

  function generateSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }

    return [Date.now().toString(36), Math.random().toString(36).slice(2), Math.random().toString(36).slice(2)].join('-');
  }

  function readStoredSession() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const sessionId = String(parsed.sessionId || '');
      const expiresAt = Number(parsed.expiresAt || 0);

      if (!sessionId || !Number.isFinite(expiresAt)) {
        return null;
      }

      return { sessionId: sessionId, expiresAt: expiresAt };
    } catch {
      return null;
    }
  }

  function writeStoredSession(session) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Ignore storage failures.
    }
  }

  function resolveSession() {
    const now = Date.now();
    const existing = readStoredSession();

    if (existing && existing.expiresAt > now) {
      return existing;
    }

    const fresh = {
      sessionId: generateSessionId(),
      expiresAt: now + DEFAULT_SESSION_WINDOW_MS,
    };

    writeStoredSession(fresh);
    return fresh;
  }

  function fetchRawCount() {
    return fetch('/api/hit-counter?ts=' + Date.now(), {
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
        const count = Number(payload && payload.count);
        render(Number.isFinite(count) ? count : 0);
      })
      .catch(function () {
        render(0);
      });
  }

  function startVisitSession() {
    const session = resolveSession();

    return fetch('/api/hit-counter/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        page: window.location.pathname,
      }),
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Failed to start visit session');
        }

        return response.json();
      })
      .then(function (payload) {
        const count = Number(payload && payload.count);
        const sessionWindowSeconds = Number(payload && payload.sessionWindowSeconds);
        const sessionWindowMs = Number.isFinite(sessionWindowSeconds) && sessionWindowSeconds > 0
          ? sessionWindowSeconds * 1000
          : DEFAULT_SESSION_WINDOW_MS;

        writeStoredSession({
          sessionId: session.sessionId,
          expiresAt: Date.now() + sessionWindowMs,
        });

        render(Number.isFinite(count) ? count : 0);
      })
      .catch(function () {
        return fetchRawCount();
      });
  }

  render(null);
  startVisitSession();
})();
