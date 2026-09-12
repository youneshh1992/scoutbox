// M18.2 — one conflict, one experience.
//
// M18.1 refused a stale write and told the person so in two different shapes:
// a persistent notice on the Room panel, and a form message on the Brief. The
// wording, the actions and the recovery differed. This is the single pattern
// every rev-guarded action uses — Room status, archive and reopen, decision
// submit, owner and lead changes, Brief edits and status changes.
//
// The contract, from the server's 409 body:
//   currentRev   the revision the record is at now
//   updatedBy    who moved it (a display name; never an id)
//   updatedAt    when
// The machine code (ROOM_VERSION_CONFLICT / BRIEF_VERSION_CONFLICT) stays on
// the error for anything that needs it and is never the primary message.
//
// The person's unsaved work is never destroyed by a conflict. The notice
// offers "Reload latest", which the CALLER implements by re-reading; a form
// that wants to keep the draft passes `onKeepChanges`, which re-arms the form
// against the new revision so the same edits can be re-applied on purpose.
import { ApiError } from './api';
import { fmtStamp, t } from './i18n';

export interface Conflict {
  code: string;
  currentRev: number | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** The shared reading of an error as a conflict, or null when it is not one. */
export function conflictOf(e: unknown): Conflict | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  if (!/VERSION_CONFLICT$/.test(e.code)) return null;
  const d = (e.details ?? {}) as Record<string, unknown>;
  return {
    code: e.code,
    currentRev: typeof d.currentRev === 'number' ? d.currentRev : null,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : null,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : null,
  };
}

export function ConflictNotice({ conflict, onReload, onKeepChanges }: {
  conflict: Conflict;
  onReload: () => void;
  /** Offered only by surfaces that can hold the draft against the new revision. */
  onKeepChanges?: () => void;
}) {
  const who = conflict.updatedBy ? conflict.updatedBy : t('conflict.someone');
  const when = conflict.updatedAt ? ` · ${fmtStamp(conflict.updatedAt)}` : '';
  return (
    <div className="notice block" role="alert" aria-live="assertive" data-conflict-code={conflict.code} style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 700 }}>{t('conflict.title')}</div>
      <div style={{ marginTop: 4 }}>{t('conflict.body').replace('{who}', who)}{when}</div>
      <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>{t('conflict.kept')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="primary" onClick={onReload}>{t('conflict.reload')}</button>
        {onKeepChanges && <button onClick={onKeepChanges}>{t('conflict.keep')}</button>}
      </div>
    </div>
  );
}
