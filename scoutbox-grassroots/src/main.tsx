import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Root error boundary: a runtime failure renders a recoverable screen, never
// a silent white page.
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, maxWidth: 560, margin: '0 auto', fontFamily: 'inherit' }}>
          <h2>Something broke in the app</h2>
          <p style={{ color: 'var(--muted)' }}>
            The error has been contained — your data lives on the server and nothing was lost.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--danger)' }}>{String(this.state.error)}</pre>
          <button className="primary" onClick={() => { this.setState({ error: null }); location.reload(); }}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>
);
