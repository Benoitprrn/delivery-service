'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import { OrderCard } from '@/components/order-card'
import { OrderModal } from '@/components/order-modal'
import { useToast } from '@/components/toast-provider'
import { apiUrl } from '@/lib/config'
import { type Order, type OrderStatus } from '@/lib/orders'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

type OrderTab = 'in-progress' | 'scheduled' | 'completed'

const TAB_CONFIG: Record<OrderTab, { label: string; statuses: readonly OrderStatus[]; emptyLabel: string }> = {
  'in-progress': {
    label: 'En cours',
    statuses: ['ASSIGNED', 'COLLECTED', 'RETURNING'],
    emptyLabel: 'Aucune livraison en cours.'
  },
  scheduled: {
    label: 'Programmé',
    statuses: ['AVAILABLE'],
    emptyLabel: 'Aucune livraison programmée.'
  },
  completed: {
    label: 'Terminé',
    statuses: ['COMPLETED', 'RETURNED', 'CANCELLED'],
    emptyLabel: 'Aucune livraison terminée.'
  }
}

const TAB_ORDER: readonly OrderTab[] = ['in-progress', 'scheduled', 'completed']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isOrder(value: unknown): value is Order {
  return isRecord(value) && typeof value.id === 'string' && typeof value.status === 'string'
}

type MerchantOrdersResponse = { zoneId: string; orders: Order[] }

function parseMerchantOrdersResponse(body: unknown): MerchantOrdersResponse | null {
  if (!isRecord(body) || typeof body.zoneId !== 'string' || !Array.isArray(body.orders)) {
    return null
  }
  if (!body.orders.every(isOrder)) {
    return null
  }
  return { zoneId: body.zoneId, orders: body.orders }
}

function compareByPickupSchedule(a: Order, b: Order): number {
  return (a.pickupScheduledAt ?? '').localeCompare(b.pickupScheduledAt ?? '')
}

function compareByUpdatedAt(a: Order, b: Order): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
}

export default function OrdersPage() {
  const { showToast } = useToast()
  const hasInitializedDefaultTab = useRef(false)

  const [orders, setOrders] = useState<Order[]>([])
  const [merchantId, setMerchantId] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [activeTab, setActiveTab] = useState<OrderTab>('scheduled')
  const [searchQuery, setSearchQuery] = useState('')

  const loadOrders = useCallback(async (): Promise<void> => {
    const supabase = createSupabaseBrowserClient()
    const {
      data: { session }
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (token === undefined) {
      throw new Error('Session expirée, reconnectez-vous.')
    }

    const response = await fetch(`${apiUrl}/api/v1/orders/merchant`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const body: unknown = await response.json()
    const parsed = parseMerchantOrdersResponse(body)
    if (!response.ok || parsed === null) {
      throw new Error('Impossible de charger les livraisons.')
    }

    setOrders(parsed.orders)
    setSelectedOrder((current) => current === null ? null : parsed.orders.find((order) => order.id === current.id) ?? null)
    setMerchantId(session?.user.id)
    if (!hasInitializedDefaultTab.current) {
      const hasInProgressOrder = parsed.orders.some((order) => TAB_CONFIG['in-progress'].statuses.includes(order.status))
      setActiveTab(hasInProgressOrder ? 'in-progress' : 'scheduled')
      hasInitializedDefaultTab.current = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function initialLoad() {
      try {
        await loadOrders()
      } catch (error) {
        if (!cancelled) {
          showToast({
            variant: 'error',
            title: 'Erreur',
            message: error instanceof Error ? error.message : 'Impossible de charger les livraisons.'
          })
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void initialLoad()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (merchantId === undefined) return
    let cancelled = false
    let socket: Socket | null = null

    function handleRealtimeEvent(payload: unknown) {
      if (isRecord(payload) && payload.merchantId === merchantId) {
        void loadOrders()
      }
    }

    function handleDispatchFailed(payload: unknown) {
      if (!isRecord(payload) || payload.merchantId !== merchantId) return
      void loadOrders()
      showToast({
        variant: 'error',
        title: 'Aucun livreur disponible',
        message: "Une de vos livraisons n'a trouvé aucun livreur — contactez le support."
      })
    }

    async function connect() {
      // Le namespace commerçant exige un JWT (voir
      // apps/api/src/realtime/socket-handler.ts io.use) — sans lui la
      // connexion est immédiatement rejetée (Unauthorized).
      const supabase = createSupabaseBrowserClient()
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (token === undefined || cancelled) return
      socket = io(apiUrl, { transports: ['websocket'], auth: { token } })
      socket.on('new_order', handleRealtimeEvent)
      socket.on('order_taken', handleRealtimeEvent)
      socket.on('order_updated', handleRealtimeEvent)
      socket.on('dispatch_failed', handleDispatchFailed)
    }

    void connect()

    return () => {
      cancelled = true
      if (socket === null) return
      socket.off('new_order', handleRealtimeEvent)
      socket.off('order_taken', handleRealtimeEvent)
      socket.off('order_updated', handleRealtimeEvent)
      socket.off('dispatch_failed', handleDispatchFailed)
      socket.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId, loadOrders])

  const ordersByTab = useMemo(() => {
    const grouped: Record<OrderTab, Order[]> = {
      'in-progress': [],
      scheduled: [],
      completed: []
    }
    for (const order of orders) {
      const tab = TAB_ORDER.find((candidate) => TAB_CONFIG[candidate].statuses.includes(order.status))
      if (tab !== undefined) grouped[tab].push(order)
    }
    grouped['in-progress'].sort(compareByPickupSchedule)
    grouped.scheduled.sort(compareByPickupSchedule)
    grouped.completed.sort(compareByUpdatedAt)
    return grouped
  }, [orders])

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const visibleOrders = useMemo(
    () => ordersByTab[activeTab].filter((order) => order.id.slice(-6).toLowerCase().includes(normalizedSearch)),
    [activeTab, normalizedSearch, ordersByTab]
  )

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-border bg-surface p-6 shadow-md">
        <Loader2 className="h-6 w-6 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
      <div className="shrink-0 border-b border-border p-5 md:p-6">
        <h1 className="text-h2 font-bold text-stone-800">Mes Livraisons</h1>
        <label className="relative mt-5 block">
          <span className="sr-only">Rechercher par numéro de commande</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Rechercher par numéro de commande"
            className="h-11 w-full rounded-lg border border-border bg-surface pl-10 pr-3 text-body text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
          />
        </label>
        <div className="mt-5 flex gap-5 overflow-x-auto" role="tablist" aria-label="Statut des livraisons">
          {TAB_ORDER.map((tab) => {
            const config = TAB_CONFIG[tab]
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  '-mb-px shrink-0 border-b-2 px-1 pb-3 text-body font-semibold transition-colors',
                  isActive ? 'border-primary-600 text-primary-700' : 'border-transparent text-stone-500 hover:text-stone-800'
                )}
              >
                {config.label} ({ordersByTab[tab].length})
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-6">
        {visibleOrders.length === 0 ? (
          <p className="text-body text-stone-400">
            {normalizedSearch.length > 0 ? 'Aucune livraison ne correspond à ce numéro.' : TAB_CONFIG[activeTab].emptyLabel}
          </p>
        ) : (
          <div className="space-y-2.5">
            {visibleOrders.map((order) => (
              <OrderCard key={order.id} order={order} onClick={() => setSelectedOrder(order)} />
            ))}
          </div>
        )}
      </div>

      <OrderModal order={selectedOrder} onOpenChange={(open) => !open && setSelectedOrder(null)} />
    </div>
  )
}
