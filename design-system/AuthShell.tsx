// ScoutBox design system — the authentication composition (M24C).
//
// One page for every portal: the brand-green page, a centred two-panel card
// (a soft-green introduction on the left, the deep-green form on the right),
// the product mark above the form, sign-in / sign-up controls only where
// both flows really exist, labelled underlined inputs and a compact rounded
// submit. The panels stack under 720px. Colours live in platform.css under
// `.auth-page` and never touch the signed-in theme tokens.
//
// The pieces keep the class names the browser suites drive — `.login`,
// `.login-toolbar`, `.org-grid`, `.org-card`, `.enter-row`, `button.primary`,
// `login-signature` — so a redesign of the surface is not a redesign of the
// tests.
import { useId, useState, type ReactNode } from 'react';

export type AuthApp = 'pro' | 'grass' | 'agent' | 'safety';

export function AuthPage({ app, product, heading, summary, points, toolbar, children, aside }: {
  app: AuthApp;
  /** The product identity beside the wordmark: Pro, Grassroots, Agent, Trust & Safety. */
  product: string;
  heading: string;
  /** M24D — one sentence under the headline; the only introduction a phone shows. */
  summary?: string;
  /** At most three short, factual lines about what exists (desktop only). */
  points: readonly string[];
  toolbar?: ReactNode;
  children: ReactNode;
  /** Optional extra content under the promotional copy (demo notices …). */
  aside?: ReactNode;
}) {
  const hid = useId();
  return (
    <div className="login auth-page" data-auth-app={app}>
      {toolbar ? <div className="login-toolbar">{toolbar}</div> : null}
      <div className="auth-card">
        <section className="auth-promo" aria-labelledby={hid}>
          <h2 id={hid}>{heading}</h2>
          {summary ? <p className="auth-summary">{summary}</p> : null}
          <ul className="auth-points">
            {points.slice(0, 3).map((p) => <li key={p.slice(0, 24)}>{p}</li>)}
          </ul>
          {aside}
        </section>
        <section className="auth-form" aria-label={`ScoutBox ${product} — sign in`}>
          <h1><span className="wordmark">ScoutBox</span><sup className="tm" aria-label="trademark">TM</sup><span className="brand-sub">{product}</span></h1>
          {children}
          <div className="login-signature" data-testid="login-signature">Built by <span>Guni &amp; Younes</span></div>
        </section>
      </div>
    </div>
  );
}

/** Sign-in / sign-up control. Render it only when both flows exist. */
export function AuthTabs<T extends string>({ tabs, value, onChange, label }: { tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="auth-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <span key={t.id} className="auth-tab-wrap">
          {i > 0 ? <span className="auth-tab-divider" aria-hidden="true">|</span> : null}
          <button type="button" role="tab" aria-selected={t.id === value} className={`auth-tab ${t.id === value ? 'on' : ''}`} onClick={() => onChange(t.id)} data-testid={`auth-tab-${t.id}`}>{t.label}</button>
        </span>
      ))}
    </div>
  );
}

/** A visible label over an underlined control. */
export function AuthField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="auth-field">
      <span className="auth-label">{label}</span>
      {children}
      {hint ? <span className="auth-hint">{hint}</span> : null}
    </label>
  );
}

/** A password input with a show / hide control; the class names given are kept on the input. */
export function PasswordInput({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <span className="auth-pw">
      <input {...rest} type={shown ? 'text' : 'password'} className={className} />
      <button type="button" className="auth-eye" onClick={() => setShown((x) => !x)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>{shown ? 'Hide' : 'Show'}</button>
    </span>
  );
}

/** M24D — a choice presented as a row: a name, one quiet line, an arrow.
 *  Keeps `.org-card` / `.org-name` so the browser suites still find it. A row
 *  that selects (organisation) carries aria-pressed; a row that acts (a demo
 *  identity) does not. */
export function AuthRow({ label, meta, selected, onClick, testId, title }: {
  label: string; meta?: string; selected?: boolean; onClick: () => void; testId?: string; title?: string;
}) {
  return (
    <button type="button" className={`org-card auth-row ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onClick} data-testid={testId} title={title}>
      <span className="auth-row-text">
        <span className="org-name">{label}</span>
        {meta ? <span className="auth-row-meta">{meta}</span> : null}
      </span>
      <span className="auth-row-arrow" aria-hidden="true">→</span>
    </button>
  );
}

/** M24D — a small uppercase label over a block of the form ("AGENCY", "Organisation"). */
export function AuthSectionLabel({ children, id }: { children: ReactNode; id?: string }) {
  return <span className="auth-label" id={id}>{children}</span>;
}

/** M24D — a quiet one-line note (demo mode, access). */
export function AuthNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="auth-note" data-testid={testId}>{children}</p>;
}

/** The access note shown instead of a public sign-up. */
export function AuthAccessNote({ children }: { children: ReactNode }) {
  return <p className="auth-access" data-testid="auth-access">{children}</p>;
}
