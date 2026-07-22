import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { client, type Me } from './data/client';
import type { InboxRequest } from './domain/types';

interface SessionState {
  playerId: string | null;
  me: Me | null;
  inbox: InboxRequest[];
  mode: 'live' | 'demo';
  login: (playerId: string) => void;
  logout: () => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [inbox, setInbox] = useState<InboxRequest[]>([]);

  const refresh = useCallback(async () => {
    if (!playerId) return;
    try {
      const [meData, inboxData] = await Promise.all([client.getMe(playerId), client.getInbox(playerId)]);
      setMe(meData);
      setInbox(inboxData);
    } catch {
      // transient — keep last good state
    }
  }, [playerId]);

  useEffect(() => {
    if (!playerId) return;
    void refresh();
    return client.onChange(() => void refresh());
  }, [playerId, refresh]);

  const value = useMemo<SessionState>(
    () => ({
      playerId,
      me,
      inbox,
      mode: client.mode,
      login: setPlayerId,
      logout: () => {
        setPlayerId(null);
        setMe(null);
        setInbox([]);
      },
      refresh,
    }),
    [playerId, me, inbox, refresh]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
