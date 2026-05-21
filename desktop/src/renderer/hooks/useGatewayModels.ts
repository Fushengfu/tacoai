import { useEffect, useRef, useState } from 'react'
import type { GatewayModelItem } from '../../shared/ipc'

/**
 * Hook to fetch gateway models from /api/member/models when logged in.
 * Waits for bridge connection before fetching.
 */
export function useGatewayModels() {
  const [models, setModels] = useState<GatewayModelItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchedRef = useRef(false)

  useEffect(() => {
    let mounted = true

    const doFetch = async () => {
      if (fetchedRef.current) return
      fetchedRef.current = true

      if (!mounted) return
      setLoading(true)
      setError(null)
      try {
        const res = await window.taco.gateway.getModels()
        if (!mounted) return
        const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
        setModels(list)
      } catch (err) {
        if (!mounted) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setModels([])
      } finally {
        if (mounted) setLoading(false)
      }
    }

    // Check initial bridge status
    window.taco.bridge.getStatus().then((s) => {
      if (s.status === 'connected' || s.status === 'connecting') {
        void doFetch()
      }
    }).catch(() => {})

    // Listen for bridge status changes
    const unsub = window.taco.bridge.onStatusChange((s) => {
      if (s.tokenExpired) {
        fetchedRef.current = false
        setModels([])
        setError(null)
        setLoading(false)
      } else if (s.status === 'connected' || s.status === 'connecting') {
        void doFetch()
      } else if (s.status === 'disconnected') {
        fetchedRef.current = false
        setModels([])
        setError(null)
        setLoading(false)
      }
    })

    return () => {
      mounted = false
      unsub()
    }
  }, [])

  const refetch = async () => {
    fetchedRef.current = false
    setLoading(true)
    setError(null)
    try {
      const res = await window.taco.gateway.getModels()
      const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
      setModels(list)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  return { models, loading, error, refetch }
}
