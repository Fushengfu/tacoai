import { useState, useCallback } from 'react'

type LoginModalProps = {
  onClose: () => void
  onLoginSuccess: (token: string, member: MemberInfo) => void
}

export type MemberInfo = {
  id: number
  username: string
  nickname: string
  avatar: string
  balance: number
  points: number
  level: number
  status: number
}

export function LoginModal({ onClose, onLoginSuccess }: Readonly<LoginModalProps>) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = useCallback(async () => {
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码')
      return
    }

    setLoading(true)
    setError('')

    try {
      const data = await window.taco.auth.login(username.trim(), password)
      const { token, member } = data as { token: string; member: MemberInfo }
      localStorage.setItem('taco.memberToken', token)
      localStorage.setItem('taco.memberInfo', JSON.stringify(member))
      onLoginSuccess(token, member)
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络请求失败')
    } finally {
      setLoading(false)
    }
  }, [username, password, onLoginSuccess])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleLogin()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="login-modal-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="login-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="login-modal-header">
          <h2>登录</h2>
          <button className="login-modal-close" type="button" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="login-modal-body">
          {error && <div className="login-modal-error">{error}</div>}

          <div className="login-modal-field">
            <label htmlFor="login-username">用户名</label>
            <input
              id="login-username"
              className="login-modal-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="login-modal-field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              className="login-modal-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </div>

          <div className="login-modal-actions">
            <button className="ghost-btn" type="button" onClick={onClose}>
              取消
            </button>
            <button
              className="primary-btn"
              type="button"
              onClick={handleLogin}
              disabled={loading}
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
