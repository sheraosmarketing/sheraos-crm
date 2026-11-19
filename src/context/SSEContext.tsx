import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type SSEHandler = (data: any) => void

interface SSECtx {
  subscribe: (event: string, handler: SSEHandler) => () => void
  connected: boolean
}

const SSEContext = createContext<SSECtx>({ subscribe: () => () => {}, connected: false })

export function SSEProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false)
  const handlers = useRef(new Map<string, Set<SSEHandler>>())
  const esRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const retryAttemptRef = useRef(0)

  useEffect(() => {
    const token = localStorage.getItem('sheraos_crm_token')
    if (!token) return

    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    const eventTypes = ['lead:created', 'lead:updated', 'lead:message', 'lead:archived', 'lead:unarchived', 'lead:archived-activity', 'broadcast:completed', 'task:updated', 'task:due', 'lead:transfer-requested', 'lead:transfer-accepted', 'lead:transfer-rejected', 'leads:resync']

    const connect = () => {
      try { esRef.current?.close() } catch {}
      const es = new EventSource(`${base}/api/events?token=${token}`)
      esRef.current = es

      es.onopen = () => {
        retryAttemptRef.current = 0
        setConnected(true)
      }
      es.onerror = () => {
        setConnected(false)
        try { es.close() } catch {}
        // Backoff exponencial: 1s, 2s, 4s, 8s, max 15s
        const delay = Math.min(15000, 1000 * Math.pow(2, retryAttemptRef.current))
        retryAttemptRef.current++
        if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = window.setTimeout(connect, delay)
      }

      for (const type of eventTypes) {
        es.addEventListener(type, (e) => {
          try {
            const data = JSON.parse((e as MessageEvent).data)
            const subs = handlers.current.get(type)
            if (subs) subs.forEach(h => h(data))
          } catch {}
        })
      }
    }

    connect()

    // Ao voltar pra aba: se SSE caiu, reconecta JA (sem esperar backoff) e dispara resync
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const es = esRef.current
      // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
      if (!es || es.readyState === 2) {
        retryAttemptRef.current = 0
        if (reconnectTimerRef.current) { window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
        connect()
      }
      // Avisa todos os subscribers de 'leads:resync' pra refazer fetch
      const subs = handlers.current.get('leads:resync')
      if (subs) subs.forEach(h => h({ reason: 'visibility' }))
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
      try { esRef.current?.close() } catch {}
      esRef.current = null
      setConnected(false)
    }
  }, [])

  const subscribe = (event: string, handler: SSEHandler) => {
    if (!handlers.current.has(event)) handlers.current.set(event, new Set())
    handlers.current.get(event)!.add(handler)
    return () => { handlers.current.get(event)?.delete(handler) }
  }

  return <SSEContext.Provider value={{ subscribe, connected }}>{children}</SSEContext.Provider>
}

export function useSSE(event: string, handler: SSEHandler) {
  const { subscribe } = useContext(SSEContext)
  useEffect(() => subscribe(event, handler), [event, handler, subscribe])
}

export const useSSEStatus = () => useContext(SSEContext).connected
