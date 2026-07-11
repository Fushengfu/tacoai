import { Component, type ErrorInfo, type ReactNode } from 'react'

type PaneErrorBoundaryProps = {
  pane: string
  title: string
  resetKey?: string
  onError?: (pane: string, error: Error, info: ErrorInfo) => void
  children: ReactNode
}

type PaneErrorBoundaryState = {
  error: Error | null
}

export class PaneErrorBoundary extends Component<PaneErrorBoundaryProps, PaneErrorBoundaryState> {
  state: PaneErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): PaneErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PaneErrorBoundary:${this.props.pane}]`, error, info)
    this.props.onError?.(this.props.pane, error, info)
  }

  componentDidUpdate(prevProps: PaneErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '18px',
          background: 'rgba(8, 11, 18, 0.9)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '560px',
            borderRadius: '18px',
            border: '1px solid rgba(99, 157, 255, 0.22)',
            background: 'rgba(18, 21, 29, 0.94)',
            boxShadow: '0 18px 44px rgba(0, 0, 0, 0.35)',
            padding: '18px 18px 16px',
            color: '#e6ebf5',
          }}
        >
          <div style={{ fontSize: '17px', fontWeight: 700, marginBottom: '8px' }}>
            {this.props.title}异常
          </div>
          <div style={{ fontSize: '13px', lineHeight: 1.7, color: 'rgba(230, 235, 245, 0.72)' }}>
            已隔离当前面板异常，避免整页界面一起崩溃。你可以直接重试当前面板，其他区域仍可继续使用。
          </div>
          <pre
            style={{
              marginTop: '12px',
              padding: '12px 14px',
              borderRadius: '12px',
              background: 'rgba(255, 255, 255, 0.04)',
              color: '#9fb3c8',
              fontSize: '12px',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '180px',
              overflow: 'auto',
            }}
          >
            {this.state.error.message || String(this.state.error)}
          </pre>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{
                border: '1px solid rgba(100, 160, 255, 0.3)',
                background: 'rgba(44, 91, 150, 0.22)',
                color: '#dfe8f6',
                borderRadius: '10px',
                padding: '8px 14px',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              重试当前面板
            </button>
          </div>
        </div>
      </div>
    )
  }
}
