import { setTransport } from './api';
import { BackendError } from './staticBackend';

// Interface tests describe the original local-server contract with a stubbed fetch. Static-backend tests
// switch back to the real published-data transport explicitly.
setTransport(async (path, init) => {
  const response = await fetch(`/api/v1/${path}`, { credentials: 'same-origin', ...init });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new BackendError(body.error?.code ?? 'request_failed', response.status); }
  return response.json();
});
