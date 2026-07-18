/**
 * 退出前保存 Hook
 * 职责：同步关键状态到 ref，注册退出前保存监听，确保应用退出时不丢数据
 */
import { useEffect, useRef } from 'react'
import type { Thread } from '../types'

interface ModelConfigLike {
  id: string
  provider: string
  [key: string]: any
}

export function useSaveOnExit(
  threads: Thread[],
  modelConfigs: ModelConfigLike[],
  activeThreadId: string,
  activeModelConfigId: string,
) {
  const threadsRef = useRef(threads)
  const modelConfigsRef = useRef(modelConfigs)
  const activeThreadIdRef = useRef(activeThreadId)
  const activeModelConfigIdRef = useRef(activeModelConfigId)

  useEffect(() => { threadsRef.current = threads }, [threads])
  useEffect(() => { modelConfigsRef.current = modelConfigs }, [modelConfigs])
  useEffect(() => { activeThreadIdRef.current = activeThreadId }, [activeThreadId])
  useEffect(() => { activeModelConfigIdRef.current = activeModelConfigId }, [activeModelConfigId])

  useEffect(() => {
    const unsubscribe = window.taco.appState.onRequestSave(async () => {
      try {
        const threadsPayload = {
          threads: threadsRef.current as any[],
          activeThreadId: activeThreadIdRef.current,
        }
        const providersPayload = {
          modelConfigs: modelConfigsRef.current as any[],
          activeModelConfigId: activeModelConfigIdRef.current,
        }
        await Promise.all([
          window.taco.appState.saveThreads(threadsPayload),
          window.taco.appState.saveProviders(providersPayload),
        ])
      } catch (err) {
        console.error('[app-state] 退出前保存失败:', err)
      } finally {
        window.taco.appState.notifySaveComplete()
      }
    })
    return unsubscribe
  }, [])
}
