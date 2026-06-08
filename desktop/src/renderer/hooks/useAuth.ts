/**
 * 认证相关 Hook
 *
 * 管理用户登录状态、Token、会员信息等。
 * Token 双写策略：同时写入文件系统（主进程）和 localStorage（渲染进程），
 * 启动时优先从文件系统加载，localStorage 作为降级方案。
 */

import { useState, useCallback, useEffect } from 'react'
import type { MemberInfo } from '../views/LoginModal'
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
    return null // 将在 useEffect 中异步加载
  })

  const [showLoginModal, setShowLoginModal] = useState(false)

  // 异步加载 Token（优先文件存储，fallback 到 localStorage）
  useEffect(() => {
    const load = async () => {
      // 1. 优先从文件存储加载
      try {
        const persisted = await window.taco.auth.loadPersistedToken()
        if (persisted && persisted.token) {
          setMemberToken(persisted.token)
          // 如果文件存储中有 memberInfo，同步到 localStorage
          if (persisted.memberInfo) {
            setMemberInfo(persisted.memberInfo as MemberInfo)
            localStorage.setItem('taco.memberInfo', JSON.stringify(persisted.memberInfo))
          }
          // 同步到 secure-storage
          await storeToken(persisted.token).catch(() => {})
          return
        }
      } catch (err) {
        console.warn('[useAuth] Failed to load from file storage:', err)
      }

      // 2. fallback: 从 localStorage 加载
      try {
        const token = await loadToken()
        if (token) {
          setMemberToken(token)
        }
      } catch (err) {
        console.error('[useAuth] Failed to load token:', err)
      }
    }
    load()
  }, [])

  /** 登录成功处理 */
  const handleLoginSuccess = useCallback(async (token: string, member: MemberInfo) => {
    try {
      // 双写：文件存储 + localStorage
      await window.taco.auth.persistToken(token, undefined, member)
      await storeToken(token)
      localStorage.setItem('taco.memberInfo', JSON.stringify(member))
      setMemberInfo(member)
      setMemberToken(token)
      setShowLoginModal(false)
    } catch (error) {
      console.error('[useAuth] Failed to store token:', error)
      // 降级方案: 仅使用 localStorage
      localStorage.setItem('taco.memberToken', token)
      setMemberToken(token)
      setShowLoginModal(false)
    }
  }, [])

  /** 登出处理 */
  const handleLogout = useCallback(async () => {
    try {
      window.taco.bridge.disconnect()
    } catch (error) {
      console.error('[useAuth] Failed to disconnect bridge:', error)
    }

    // 双删：文件存储 + localStorage
    try {
      await window.taco.auth.removePersistedToken()
    } catch (error) {
      console.warn('[useAuth] Failed to remove persisted token:', error)
    }

    try {
      await removeToken()
    } catch (error) {
      console.error('[useAuth] Failed to remove token:', error)
    }

    localStorage.removeItem('taco.memberInfo')
    localStorage.removeItem('taco.memberToken')
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
        // Token 过期，清除所有存储
        window.taco.auth.removePersistedToken().catch(() => {})
        removeToken().catch(() => {})
        localStorage.removeItem('taco.memberInfo')
        localStorage.removeItem('taco.memberToken')
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
