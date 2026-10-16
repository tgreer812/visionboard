// Per-browser list of rooms you've opened. Purely a convenience; never shared.
const KEY = 'vb:recent';

export function recentRooms() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberRoom(id, title) {
  try {
    const list = recentRooms().filter((r) => r.id !== id);
    list.unshift({ id, title: title || '', at: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch { /* storage blocked */ }
}
