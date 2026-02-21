const STORAGE_KEY = 'trendhunt_admin_token';

export function getStoredAdminToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (sessionStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setStoredAdminToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = token.trim();
    if (clean) {
      sessionStorage.setItem(STORAGE_KEY, clean);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
}

export function getAdminHeaders(): Record<string, string> {
  const token = getStoredAdminToken();
  return token ? { 'x-admin-token': token } : {};
}
