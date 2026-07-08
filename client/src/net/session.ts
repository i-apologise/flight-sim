const TAB_UUID_KEY = 'fs_tab_uuid';
const NICK_KEY = 'fs_nick';

/**
 * Per-tab identity so two tabs can both play multiplayer.
 * Nickname stays in localStorage for convenience.
 */
export function getOrCreateUuid(): string {
  try {
    let id = sessionStorage.getItem(TAB_UUID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(TAB_UUID_KEY, id);
    }
    return id;
  } catch {
    // private mode fallback
    return crypto.randomUUID();
  }
}

/** Force a new pilot identity in this tab (for testing). */
export function resetTabUuid(): string {
  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(TAB_UUID_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

export function loadNickname(): string {
  try {
    return localStorage.getItem(NICK_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveNickname(n: string): void {
  try {
    localStorage.setItem(NICK_KEY, n);
  } catch {
    /* ignore */
  }
}
