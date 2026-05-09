/**
 * BridgePanel — 桌面端桥接面板
 *
 * 流程：
 * 1. 使用全局会员 token 连接桥接服务
 * 2. 连接成功后显示配对码（二维码）
 * 3. 移动端扫码配对码即可连接（二维码包含 token + code + relayUrl）
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { BridgeStatusPayload, BridgeConnectionStatusType } from '../../shared/ipc'

type BridgePanelProps = {
  onClose: () => void
  memberToken: string | null
}

function statusLabel(status: BridgeConnectionStatusType): string {
  switch (status) {
    case 'disconnected': return '未连接'
    case 'connecting': return '连接中...'
    case 'connected': return '已连接'
    case 'reconnecting': return '重连中...'
    default: return status
  }
}

export function BridgePanel({ onClose, memberToken }: Readonly<BridgePanelProps>) {
  const [status, setStatus] = useState<BridgeStatusPayload>(() => ({ status: 'disconnected', clientCount: 0 }))
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  const hasConnectedRef = useRef(false)

  // 挂载时获取当前状态并注册监听
  useEffect(() => {
    let mounted = true
    window.taco.bridge.getStatus().then((s) => {
      if (mounted) {
        setStatus(s)
        if (s.pairingCode) {
          setPairingCode(s.pairingCode)
          hasConnectedRef.current = true
        }
      }
    })

    const unsubStatus = window.taco.bridge.onStatusChange((s) => {
      if (mounted) {
        setStatus(s)
        if (s.pairingCode) {
          setPairingCode(s.pairingCode)
          if (!hasConnectedRef.current) {
            hasConnectedRef.current = true
            setConnecting(false)
          }
        }
        if (s.status === 'disconnected' && !s.pairingCode) {
          setPairingCode(null)
          hasConnectedRef.current = false
        }
        if (s.error) {
          setError(s.error)
          setConnecting(false)
        }
      }
    })

    const unsubCode = window.taco.bridge.onPairingCode((code) => {
      if (mounted) {
        setPairingCode(code)
        setConnecting(false)
      }
    })

    return () => { mounted = false; unsubStatus(); unsubCode() }
  }, [])

  const handleConnect = useCallback(() => {
    if (!memberToken) return
    setConnecting(true)
    setError('')
    window.taco.bridge.connect(memberToken)
  }, [memberToken])

  const handleDisconnect = useCallback(() => {
    window.taco.bridge.disconnect()
    setPairingCode(null)
    hasConnectedRef.current = false
  }, [])

  // 生成二维码 URL（使用 QRCode API）
  // 二维码内容格式：taco-bridge://base64(json)
  // json: {"token":"...","code":"...","url":"..."}
  const qrCodeUrl = pairingCode && memberToken
    ? (() => {
        const payload = JSON.stringify({
          token: memberToken,
          code: pairingCode,
          url: 'wss://aisocket.bjctykj.com',
        })
        // 使用浏览器原生 btoa，支持 UTF-8
        const base64 = btoa(unescape(encodeURIComponent(payload)))
        const qrData = `taco-bridge://${base64}`
        return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`
      })()
    : null

  return (
    <div className="bridge-panel">
      <div className="bridge-panel-header">
        <h3 className="bridge-panel-title">跨端桥接</h3>
        <button
          type="button"
          className="bridge-panel-close"
          onClick={onClose}
          aria-label="关闭桥接面板"
        >
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="bridge-panel-body">
        {/* 状态指示 */}
        <div className="bridge-status-row">
          <span className={`bridge-status-dot ${status.status}`} />
          <span className="bridge-status-text">{statusLabel(status.status)}</span>
          {status.clientCount > 0 && (
            <span className="bridge-peer-badge">{status.clientCount} 设备</span>
          )}
        </div>

        {/* 未登录提示 */}
        {!memberToken && (
          <div className="bridge-not-logged-in">
            <p>请先在左下角登录会员账号</p>
          </div>
        )}

        {/* 已登录但未连接 */}
        {memberToken && !pairingCode && !connecting && (
          <div className="bridge-connect-section">
            <button
              type="button"
              className="bridge-btn bridge-btn-primary"
              onClick={handleConnect}
            >
              连接桥接服务
            </button>
          </div>
        )}

        {/* 连接中 */}
        {connecting && (
          <div className="bridge-connecting">
            <p>正在连接桥接服务...</p>
          </div>
        )}

        {/* 已连接：显示配对码和二维码 */}
        {pairingCode && (
          <div className="bridge-pairing-section">
            <div className="bridge-pairing-label">配对码</div>
            <code className="bridge-pairing-code">{pairingCode}</code>

            {qrCodeUrl && (
              <div className="bridge-qr-code">
                <img src={qrCodeUrl} alt="配对二维码" width={200} height={200} />
              </div>
            )}

            <p className="bridge-pairing-hint">
              打开手机端 Taco AI App，扫描上方二维码即可连接
            </p>

            <button
              type="button"
              className="bridge-btn bridge-btn-danger"
              onClick={handleDisconnect}
            >
              断开桥接
            </button>
          </div>
        )}

        {/* 错误信息 */}
        {error && <p className="bridge-error">{error}</p>}
      </div>
    </div>
  )
}
