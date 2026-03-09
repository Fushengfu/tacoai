import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import './styles.css'

window.addEventListener('error', (event) => {
  console.error('[RendererWindowError]', event.error ?? event.message)
  const err = event.error
  void window.taco.shell.reportRendererError({
    source: 'window-error',
    message: err instanceof Error
      ? (err.message || String(err))
      : String(event.message || 'window error'),
    stack: err instanceof Error ? err.stack : undefined,
    metadata: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
  }).catch(() => {
    // ignore logging failures
  })
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[RendererUnhandledRejection]', event.reason)
  const reason = event.reason
  const message = reason instanceof Error
    ? (reason.message || String(reason))
    : typeof reason === 'string'
      ? reason
      : 'Unhandled promise rejection'
  void window.taco.shell.reportRendererError({
    source: 'unhandledrejection',
    message,
    stack: reason instanceof Error ? reason.stack : undefined,
    metadata: {
      reason: typeof reason === 'string' ? reason : String(reason),
    },
  }).catch(() => {
    // ignore logging failures
  })
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
)
