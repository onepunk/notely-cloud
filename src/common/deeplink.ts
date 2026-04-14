
export function parseDeepLink(url: string): { route: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'notely:') return null;
    const path = (u.host + u.pathname).replace(/\+/g, '/');
    if (path.startsWith('binders/')) {
      const parts = path.split('/');
      const binderId = parts[1];
      if (!/^[a-z0-9-]{1,64}$/i.test(binderId)) return null;
      if (parts[2] === 'notes' && parts[3]) {
        const noteId = parts[3];
        if (!/^[0-9a-f-]{16,}$/i.test(noteId)) return null;
        return { route: `/binders/${binderId}/notes/${noteId}` };
      }
      return { route: `/binders/${binderId}` };
    }
    if (path.startsWith('settings')) {
      const section = path.split('/')[1] || 'system';
      if (!/^[a-z]+$/i.test(section)) return null;
      return { route: `/settings/${section}` };
    }
    return null;
  } catch {
    return null;
  }
}
