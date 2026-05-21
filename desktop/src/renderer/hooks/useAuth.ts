/**
 * 认证相关 Hook
 * 
 * 管理用户登录状态、Token、会员信息等
 */

import { useState, useCallback, useEffect } from 'react'
import type { MemberInfo } from '../components/LoginModal'
import { storeToken, loadToken, removeToken } from '../lib/secure-storage'

export function useAuth() {
  const [memberInfo, setMemberInfo] = useState<MemberInfo | null>(() => {
    try {
      const stored = localStorage.getItem('taco.memberInfo')
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })
  
  const [memberToken, setMemberToken] = useState<string | null>(() => {
    // 从安全存储中加载 Token
    return null // 将在 useEffect 中异步加载
  })
  
  const [showLoginModal, setShowLoginModal] = useState(false)

  // 异步加载 Token
  useEffect(() => {
    loadToken().then(token => {
      if (token) {
        setMemberToken(token)
      }
    }).catch(err => {
      console.error('[useAuth] Failed to load token:', err)
    })
  }, [])

  /** 登录成功处理 */
  const handleLoginSuccess = useCallback(async (token: string, member: MemberInfo) => {
    try {
      // 使用安全存储
      await storeToken(token)
      localStorage.setItem('taco.memberInfo', JSON.stringify(member))
      setMemberInfo(member)
      setMemberToken(token)
      setShowLoginModal(false)
    } catch (error) {
      console.error('[useAuth] Failed to store token:', error)
      // 降级方案: 使用 localStorage
      localStorage.setItem('taco.memberToken', token)
      setMemberToken(token)
    }
  }, [])

  /** 登出处理 */
  const handleLogout = useCallback(async () => {
    try {
      // 断开桥接服务
      window.taco.bridge.disconnect()
    } catch (error) {
      console.error('[useAuth] Failed to disconnect bridge:', error)
    }
    
    try {
      // 使用安全存储删除
      await removeToken()
    } catch (error) {
      console.error('[useAuth] Failed to remove token:', error)
    }
    
    localStorage.removeItem('taco.memberInfo')
    localStorage.removeItem('taco.memberToken') // 清理旧的明文 Token
    setMemberInfo(null)
    setMemberToken(null)
  }, [])

  /** 显示登录框 */
  const showLogin = useCallback(() => {
    setShowLoginModal(true)
  }, [])

  /** 隐藏登录框 */
  const hideLogin = useCallback(() => {
    setShowLoginModal(false)
  }, [])

  // 监听 Token 过期事件，弹出登录框
  useEffect(() => {
    const unsub = window.taco.bridge.onStatusChange((s) => {
      if (s.tokenExpired) {
        // Token 过期，清除本地 token 和安全存储，弹出登录框
        removeToken().catch(() => {})
        setMemberToken(null)
        setMemberInfo(null)
        setShowLoginModal(true)
      }
    })
    return unsub
  }, [])

  // 已登录时自动连接桥接服务
  useEffect(() => {
    if (!memberToken) return
    let mounted = true
    window.taco.bridge.getStatus().then((s) => {
      if (mounted && s.status === 'disconnected') {
        window.taco.bridge.connect(memberToken)
      }
    })
    return () => { mounted = false }
  }, [memberToken])

  return {
    memberInfo,
    memberToken,
    showLoginModal,
    handleLoginSuccess,
    handleLogout,
    showLogin,
    hideLogin,
  }
}
