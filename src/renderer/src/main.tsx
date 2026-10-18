import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Fonts ship inside the app (works offline; the page's CSP blocks remote stylesheets anyway).
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './index.css'

/** Shows what went wrong instead of a blank window if a component throws. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main style={{ padding: 24 }}>
        <h2>Something went wrong</h2>
        <p>Your USB has not been changed. Restart the app, and please report this message:</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error.stack ?? this.state.error)}</pre>
      </main>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
