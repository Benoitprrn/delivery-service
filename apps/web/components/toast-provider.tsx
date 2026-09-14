'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Toast, type ToastVariant } from '@/components/ui/toast'

type ToastItem = {
  id: number
  variant: ToastVariant
  title: string | undefined
  message: string | undefined
}

type ShowToastInput = {
  variant?: ToastVariant
  title?: string
  message?: string
}

type ToastContextValue = {
  showToast: (input: ShowToastInput) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)
const TOAST_DURATION_MS = 4_000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const showToast = useCallback(
    (input: ShowToastInput) => {
      const id = Date.now() + Math.random()
      setToasts((current) => [
        ...current,
        { id, variant: input.variant ?? 'success', title: input.title, message: input.message }
      ])
      setTimeout(() => dismiss(id), TOAST_DURATION_MS)
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-toast flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto w-full sm:w-auto">
            <Toast variant={toast.variant} title={toast.title} message={toast.message} onClose={() => dismiss(toast.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}
