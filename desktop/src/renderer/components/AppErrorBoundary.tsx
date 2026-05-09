import { Component, type ErrorInfo, type ReactNode } from 'react'

const AUTO_RECOVERY_SESSION_KEY = 'taco.rendererErrorAutoRecoveryAt'
const AUTO_RECOVERY_COOLDOWN_MS = 30_000

type AppErrorBoundaryProps = {
  children: ReactNode
}

type AppErrorBoundaryState = {
  error: Error | null
  autoRecovering: boolean
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    autoRecovering: false,
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      error,
      autoRecovering: false,
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RendererErrorBoundary]', error, info)
    void window.taco.shell.reportRendererError({
      source: 'app-boundary',
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
      metadata: {
        autoRecoveryCooldownMs: AUTO_RECOVERY_COOLDOWN_MS,
      },
    }).catch(() => {
      // ignore logging failures
    })

    let shouldAutoRecover = false
    try {
      const now = Date.now()
      const last = Number(sessionStorage.getItem(AUTO_RECOVERY_SESSION_KEY) ?? '0')
      if (!Number.isFinite(last) || (now - last) > AUTO_RECOVERY_COOLDOWN_MS) {
        sessionStorage.setItem(AUTO_RECOVERY_SESSION_KEY, String(now))
        shouldAutoRecover = true
      }
    } catch {
      // ignore sessionStorage failures
    }

    if (!shouldAutoRecover) return

    this.setState({ autoRecovering: true })
    window.setTimeout(() => {
      window.location.reload()
    }, 700)
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
          background: 'radial-gradient(circle at top, rgba(38, 79, 120, 0.18), rgba(11, 12, 14, 0.96) 58%)',
          color: '#e8e9ee',
        }}
      >
        <div
          style={{
            width: 'min(560px, 100%)',
            borderRadius: '24px',
            border: '1px solid rgba(100, 160, 255, 0.2)',
            background: 'rgba(16, 18, 24, 0.92)',
            boxShadow: '0 24px 90px rgba(0, 0, 0, 0.45)',
            padding: '28px 28px 24px',
          }}
        >
          <div style={{ fontSize: '28px', fontWeight: 700, marginBottom: '12px' }}>
            {this.state.autoRecovering ? '界面异常，正在自动恢复' : '界面渲染异常'}
          </div>
          <div style={{ fontSize: '15px', lineHeight: 1.7, color: 'rgba(232, 233, 238, 0.74)' }}>
            {this.state.autoRecovering
              ? '检测到渲染层异常，系统正在尝试重新加载当前界面。'
              : '渲染层抛出了未捕获异常，已拦截整页黑屏。你可以立即重新加载界面继续使用。'}
          </div>
          {!this.state.autoRecovering && (
            <pre
              style={{
                marginTop: '18px',
                padding: '14px 16px',
                borderRadius: '14px',
                background: 'rgba(255, 255, 255, 0.04)',
                color: '#9fb3c8',
                fontSize: '12px',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {this.state.error.message || String(this.state.error)}
            </pre>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '22px' }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                border: '1px solid rgba(100, 160, 255, 0.32)',
                background: 'rgba(44, 91, 150, 0.22)',
                color: '#dfe8f6',
                borderRadius: '12px',
                padding: '10px 16px',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              重新加载界面
            </button>
          </div>
        </div>
      </div>
    )
  }
}
