const BASE_URL = process.env.BASE_URL || 'https://chatelheraultrc.com';

const PUBLIC_PATHS = [
  '/',
  '/contact',
  '/meetups',
  '/media',
  '/spotlight',
  '/members-rigs',
  '/grounds',
  '/sponsors',
  '/privacy-policy',
  '/privacy-protocol',
  '/safety-guidelines',
  '/terms-of-service',
  '/register-rig',
  '/rig-approvals',
];

const REDIRECT_PATHS = [
  '/pages/contact',
  '/pages/meetups',
  '/pages/media',
  '/pages/spotlight',
  '/pages/members-rigs',
  '/pages/grounds',
  '/pages/sponsors',
];

function buildUrl(pathname) {
  const url = new URL(BASE_URL);
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

async function checkStatus(url, expectedStatuses) {
  const response = await fetch(url, { method: 'GET', redirect: 'manual' });
  const ok = expectedStatuses.includes(response.status);
  return {
    ok,
    status: response.status,
    location: response.headers.get('location') || '',
  };
}

async function main() {
  let failed = false;

  for (const path of PUBLIC_PATHS) {
    const url = buildUrl(path);
    const result = await checkStatus(url, [200]);

    if (!result.ok) {
      failed = true;
      console.error(`FAIL public ${path}: expected 200, got ${result.status}`);
    }
  }

  for (const path of REDIRECT_PATHS) {
    const url = buildUrl(path);
    const result = await checkStatus(url, [301, 302, 307, 308]);

    if (!result.ok) {
      failed = true;
      console.error(`FAIL redirect ${path}: expected redirect, got ${result.status}`);
      continue;
    }

    if (!result.location) {
      failed = true;
      console.error(`FAIL redirect ${path}: missing Location header`);
    }
  }

  const workerHostUrl = 'https://chatelherault-rc-website.fraz-er.workers.dev/';
  const workerHostResult = await checkStatus(workerHostUrl, [301, 302, 307, 308]);

  if (!workerHostResult.ok || !workerHostResult.location.includes('chatelheraultrc.com')) {
    failed = true;
    console.error(
      `FAIL workers.dev redirect: expected redirect to apex, got status=${workerHostResult.status}, location=${workerHostResult.location}`
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`Route verification passed for ${PUBLIC_PATHS.length} public paths and ${REDIRECT_PATHS.length} redirect paths.`);
}

main().catch((error) => {
  console.error('Route verification failed with exception:', error && error.message ? error.message : error);
  process.exit(1);
});
