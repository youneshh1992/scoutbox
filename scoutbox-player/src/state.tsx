import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { client, type Me } from './data/client';
import type { AppNotification, Channel } from './data/types';
import type { ChildInboxItem, Guardian, GuardianInboxRequest, InboxRequest } from './domain/types';
import { isAdult } from './domain/safeguarding';

const SESSION_KEY = 'scoutbox-player-session';

function loadStoredSession(): { kind: 'player' | 'guardian'; id: string } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeSession(value: { kind: 'player' | 'guardian'; id: string } | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

interface SessionState {
  kind: 'player' | 'guardian' | null;
  playerId: string | null;
  guardianId: string | null;
  me: Me | null;
  /** True when the logged-in player is under 18 (guardian-managed account). */
  isMinor: boolean;
  inbox: (InboxRequest | ChildInboxItem)[];
  guardian: Guardian | null;
  guardianInbox: GuardianInboxRequest[];
  children: Me[];
  notifications: AppNotification[];
  unread: number;
  /** Messages from clubs newer than the last thread-open, across channels. */
  unreadMessages: number;
  channels: Channel[];
  /** Transient popup for a freshly arrived notification. */
  popup: string | null;
  dismissPopup: () => void;
  markNotificationsRead: () => Promise<void>;
  mode: 'live' | 'demo';
  /** Live-sync stream health (always true in demo mode). */
  liveConnected: boolean;
  loginPlayer: (playerId: string) => void;
  loginGuardian: (guardianId: string) => void;
  logout: () => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children: kids }: { children: ReactNode }) {
  const stored = loadStoredSession();
  const [playerId, setPlayerId] = useState<string | null>(stored?.kind === 'player' ? stored.id : null);
  const [guardianId, setGuardianId] = useState<string | null>(stored?.kind === 'guardian' ? stored.id : null);
  const [me, setMe] = useState<Me | null>(null);
  const [inbox, setInbox] = useState<(InboxRequest | ChildInboxItem)[]>([]);
  const [guardian, setGuardian] = useState<Guardian | null>(null);
  const [guardianInbox, setGuardianInbox] = useState<GuardianInboxRequest[]>([]);
  const [childProfiles, setChildProfiles] = useState<Me[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [popup, setPopup] = useState<string | null>(null);
  const seenNotifIds = useRef<Set<string> | null>(null);
  const popupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pop-up banner whenever a new unread notification arrives.
  const surfaceFresh = useCallback((notifs: AppNotification[]) => {
    if (seenNotifIds.current === null) {
      seenNotifIds.current = new Set(notifs.map((n) => n.id));
      return;
    }
    const fresh = notifs.filter((n) => !n.read && !seenNotifIds.current!.has(n.id));
    for (const n of notifs) seenNotifIds.current.add(n.id);
    if (fresh.length > 0) {
      setPopup(`🔔 ${fresh[0].text}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`);
      if (popupTimer.current) clearTimeout(popupTimer.current);
      popupTimer.current = setTimeout(() => setPopup(null), 5000);
    }
  }, []);

  // Everything fetched for one identity is dropped before another takes over
  // (or on logout) — no cross-account leakage through client state.
  const clearIdentityState = useCallback(() => {
    setMe(null);
    setInbox([]);
    setGuardian(null);
    setGuardianInbox([]);
    setChildProfiles([]);
    setNotifications([]);
    setChannels([]);
    setPopup(null);
    seenNotifIds.current = null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      if (playerId) {
        const [meData, inboxData, notifs, chans] = await Promise.all([
          client.getMe(playerId),
          client.getInbox(playerId),
          client.getNotifications(playerId),
          client.getChannels(playerId).catch(() => [] as Channel[]),
        ]);
        setMe(meData);
        setInbox(inboxData);
        setNotifications(notifs);
        setChannels(chans);
        surfaceFresh(notifs);
      }
      if (guardianId) {
        const [g, gi, ch, notifs, chans] = await Promise.all([
          client.guardianMe(guardianId),
          client.guardianInbox(guardianId),
          client.guardianChildren(guardianId),
          client.guardianNotifications(guardianId),
          client.guardianChannels(guardianId).catch(() => [] as Channel[]),
        ]);
        setGuardian(g);
        setGuardianInbox(gi);
        setChildProfiles(ch);
        setNotifications(notifs);
        setChannels(chans);
        surfaceFresh(notifs);
      }
    } catch {
      // transient — keep last good state
    }
  }, [playerId, guardianId, surfaceFresh]);

  const markNotificationsRead = useCallback(async () => {
    try {
      if (playerId) await client.markNotificationsRead(playerId);
      if (guardianId) await client.guardianMarkNotificationsRead(guardianId);
      await refresh();
    } catch {
      /* stays unread */
    }
  }, [playerId, guardianId, refresh]);

  const [liveConnected, setLiveConnected] = useState(true);
  useEffect(() => {
    if (!playerId && !guardianId) return;
    void refresh();
    const auth = guardianId
      ? ({ kind: 'guardian', id: guardianId } as const)
      : ({ kind: 'player', id: playerId! } as const);
    return client.onChange((event, payload) => {
      if (event === 'typing') return; // ephemeral — screens listen for it directly
      if (event === 'sse_status') {
        setLiveConnected((payload as { connected?: boolean } | undefined)?.connected !== false);
        return;
      }
      void refresh(); // includes 'reconnected' — the authoritative catch-up refetch
    }, auth);
  }, [playerId, guardianId, refresh]);

  const value = useMemo<SessionState>(
    () => ({
      kind: guardianId ? 'guardian' : playerId ? 'player' : null,
      playerId,
      guardianId,
      me,
      isMinor: !!me && !isAdult(me.dob, me.country),
      inbox,
      guardian,
      guardianInbox,
      children: childProfiles,
      notifications,
      unread: notifications.filter((n) => !n.read).length,
      unreadMessages: channels.reduce(
        (sum, c) => sum + c.messages.filter((m) => m.sender.kind === 'org_user' && m.ts > (c.readBy?.counterparty ?? 0)).length,
        0
      ),
      channels,
      popup,
      dismissPopup: () => setPopup(null),
      markNotificationsRead,
      mode: client.mode,
      liveConnected,
      loginPlayer: (id) => {
        clearIdentityState();
        setGuardianId(null);
        setPlayerId(id);
        storeSession({ kind: 'player', id });
      },
      loginGuardian: (id) => {
        clearIdentityState();
        setPlayerId(null);
        setGuardianId(id);
        storeSession({ kind: 'guardian', id });
      },
      logout: () => {
        clearIdentityState();
        setPlayerId(null);
        setGuardianId(null);
        storeSession(null);
      },
      refresh,
    }),
    [playerId, guardianId, me, inbox, guardian, guardianInbox, childProfiles, notifications, channels, popup, liveConnected, markNotificationsRead, refresh, clearIdentityState]
  );

  return <SessionContext.Provider value={value}>{kids}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
