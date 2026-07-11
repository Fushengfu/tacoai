import { useState, useCallback, useEffect, useRef } from 'react'

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

type AuthTab = 'login' | 'register'

// 使用 Web Crypto API 进行 SHA256 哈希
async function hashPasswordSHA256(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return hashHex
}

export function LoginModal({ onClose, onLoginSuccess }: Readonly<LoginModalProps>) {
  const [tab, setTab] = useState<AuthTab>('login')
  
  // 登录状态
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  
  // 注册状态
  const [regPassword, setRegPassword] = useState('')
  const [regNickname, setRegNickname] = useState('')
  const [regPhone, setRegPhone] = useState('')
  const [regEmail, setRegEmail] = useState('')
  
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  
  const panelRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  // Escape 键关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleLogin = useCallback(async () => {
    if (!loginUsername.trim() || !loginPassword.trim()) {
      setError('请输入用户名和密码')
      return
    }

    setLoading(true)
    setError('')

    try {
      // 对密码进行 SHA256 加密后再发送
      const hashedPassword = await hashPasswordSHA256(loginPassword)
      const data = await window.taco.auth.login(loginUsername.trim(), hashedPassword)
      const { token, member } = data as { token: string; member: MemberInfo }
      localStorage.setItem('taco.memberToken', token)
      localStorage.setItem('taco.memberInfo', JSON.stringify(member))
      onLoginSuccess(token, member)
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络请求失败')
    } finally {
      setLoading(false)
    }
  }, [loginUsername, loginPassword, onLoginSuccess])

  const handleRegister = useCallback(async () => {
    if (!regPassword.trim()) {
      setError('请输入密码')
      return
    }
    if (regPassword.trim().length < 6) {
      setError('密码至少6个字符')
      return
    }
    // 手机号必填
    const phone = regPhone.trim()
    if (!phone) {
      setError('手机号为必填项')
      return
    }
    // 校验手机号格式（11位数字）
    if (phone.length !== 11 || !/^\d{11}$/.test(phone)) {
      setError('手机号格式不正确，请输入11位数字手机号')
      return
    }
    // 校验邮箱格式（如果填写了）
    const email = regEmail.trim()
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError('邮箱格式不正确')
        return
      }
    }

    setLoading(true)
    setError('')

    try {
      // 对密码进行 SHA256 加密后再发送
      const hashedPassword = await hashPasswordSHA256(regPassword)
      const data = await window.taco.auth.register(
        phone,
        hashedPassword,
        regNickname.trim() || undefined,
        phone,
        email || undefined
      )
      const { token, member } = data as { token: string; member: MemberInfo }
      localStorage.setItem('taco.memberToken', token)
      localStorage.setItem('taco.memberInfo', JSON.stringify(member))
      onLoginSuccess(token, member)
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络请求失败')
    } finally {
      setLoading(false)
    }
  }, [regPassword, regNickname, regPhone, regEmail, onLoginSuccess])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (tab === 'login') {
        handleLogin()
      } else {
        handleRegister()
      }
    }
  }

  return (
    <div className="login-modal-overlay">
      <div className="login-modal-backdrop" />
      <div 
        ref={panelRef}
        className="login-modal-panel" 
        onClick={(e) => e.stopPropagation()} 
        role="dialog" 
        aria-modal="true"
        onKeyDown={handleKeyDown}
      >
        <div className="login-modal-header">
          <div className="login-modal-tabs">
            <button
              type="button"
              className={`login-modal-tab ${tab === 'login' ? 'active' : ''}`}
              onClick={() => { setTab('login'); setError('') }}
            >
              登录
            </button>
            <button
              type="button"
              className={`login-modal-tab ${tab === 'register' ? 'active' : ''}`}
              onClick={() => { setTab('register'); setError('') }}
            >
              注册
            </button>
          </div>
          <button className="login-modal-close" type="button" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="login-modal-body">
          {error && <div className="login-modal-error">{error}</div>}

          {tab === 'login' ? (
            <>
              <div className="login-modal-field">
                <label htmlFor="login-username">用户名</label>
                <input
                  id="login-username"
                  className="login-modal-input"
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
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
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
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
            </>
          ) : (
            <>
              <div className="login-modal-field">
                <label htmlFor="reg-password">密码</label>
                <input
                  id="reg-password"
                  className="login-modal-input"
                  type="password"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="至少6个字符"
                  autoComplete="new-password"
                  autoFocus
                />
              </div>

              <div className="login-modal-field">
                <label htmlFor="reg-nickname">昵称（可选）</label>
                <input
                  id="reg-nickname"
                  className="login-modal-input"
                  type="text"
                  value={regNickname}
                  onChange={(e) => setRegNickname(e.target.value)}
                  placeholder="显示名称"
                  autoComplete="nickname"
                />
              </div>

              <div className="login-modal-field">
                <label htmlFor="reg-phone">手机号<span className="required-star">*</span></label>
                <input
                  id="reg-phone"
                  className="login-modal-input"
                  type="tel"
                  value={regPhone}
                  onChange={(e) => setRegPhone(e.target.value)}
                  placeholder="11位手机号（将作为登录账号名）"
                  autoComplete="tel"
                />
              </div>

              <div className="login-modal-field">
                <label htmlFor="reg-email">邮箱（可选）</label>
                <input
                  id="reg-email"
                  className="login-modal-input"
                  type="email"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="example@mail.com"
                  autoComplete="email"
                />
              </div>

              <div className="login-modal-actions">
                <button className="ghost-btn" type="button" onClick={onClose}>
                  取消
                </button>
                <button
                  className="primary-btn"
                  type="button"
                  onClick={handleRegister}
                  disabled={loading}
                >
                  {loading ? '注册中...' : '注册'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
