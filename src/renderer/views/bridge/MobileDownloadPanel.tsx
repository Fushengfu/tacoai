/**
 * MobileDownloadPanel — 手机端下载面板
 *
 * 提供：
 * 1. 扫码下载二维码（手机扫描直接下载安装）
 * 2. 电脑下载 Android 安装包按钮
 *
 * 下载地址从版本检查 API 获取，失败时显示错误提示。
 */

import { useEffect, useState } from 'react'

const ANDROID_PACKAGE_NAME = 'cn.zhongnanke.taco'

type MobileDownloadPanelProps = {
  onClose: () => void
}

type LoadState =
  | { type: 'loading' }
  | { type: 'ready'; downloadUrl: string; version?: string }
  | { type: 'error'; message: string }

export function MobileDownloadPanel({ onClose }: Readonly<MobileDownloadPanelProps>) {
  const [state, setState] = useState<LoadState>({ type: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ type: 'loading' })
    window.taco.bridge
      .getMobileApkInfo(ANDROID_PACKAGE_NAME)
      .then((info) => {
        if (cancelled) return
        if (info?.downloadUrl) {
          setState({ type: 'ready', downloadUrl: info.downloadUrl, version: info.version })
        } else {
          setState({ type: 'error', message: '暂无可用版本，请稍后重试' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ type: 'error', message: '获取下载地址失败，请检查网络后重试' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  let body: JSX.Element
  if (state.type === 'loading') {
    body = (
      <div className="bridge-pairing-section">
        <div className="bridge-qr-code" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
          <span style={{ color: 'var(--text-secondary, #999)' }}>加载中...</span>
        </div>
      </div>
    )
  } else if (state.type === 'error') {
    body = (
      <div className="bridge-pairing-section">
        <div className="bridge-qr-code" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 48, opacity: 0.5 }}>!</span>
          <span style={{ color: 'var(--text-secondary, #999)', textAlign: 'center', lineHeight: 1.6 }}>{state.message}</span>
        </div>
      </div>
    )
  } else {
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(state.downloadUrl)}`
    body = (
      <div className="bridge-pairing-section">
        <div className="bridge-pairing-label">扫码下载</div>

        <div className="bridge-qr-code">
          <img src={qrCodeUrl} alt="手机端下载二维码" width={200} height={200} />
        </div>

        <p className="bridge-pairing-hint">
          使用手机扫描二维码下载安装 Taco AI 手机端
        </p>

        <a
          href={state.downloadUrl}
          className="bridge-btn bridge-btn-primary"
          download="taco-ai-android.apk"
          target="_blank"
          rel="noopener noreferrer"
        >
          下载 Android 安装包
        </a>
      </div>
    )
  }

  return (
    <div className="bridge-panel mobile-download-panel">
      <div className="bridge-panel-header">
        <h3 className="bridge-panel-title">下载手机端</h3>
        <button
          type="button"
          className="bridge-panel-close"
          onClick={onClose}
          aria-label="关闭下载面板"
        >
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="bridge-panel-body">
        {body}
      </div>
    </div>
  )
}
