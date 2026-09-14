import { AlertTriangle, Check, Info, X, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToastVariant = 'success' | 'warning' | 'error' | 'info'

export type ToastProps = {
  variant?: ToastVariant
  title?: string | undefined
  message?: string | undefined
  onClose?: (() => void) | undefined
}

const variantConfig: Record<ToastVariant, { className: string; icon: LucideIcon }> = {
  success: { className: 'bg-primary-600', icon: Check },
  warning: { className: 'bg-accent-600', icon: AlertTriangle },
  error: { className: 'bg-red-600', icon: X },
  info: { className: 'bg-blue-600', icon: Info }
}

export function Toast({ variant = 'success', title, message, onClose }: ToastProps) {
  const { className, icon: Icon } = variantConfig[variant]

  return (
    <div className={cn('flex w-full max-w-sm items-start gap-3 rounded-lg px-4 py-3.5 text-white shadow-lg', className)}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {title !== undefined && <p className="text-body-sm font-bold">{title}</p>}
        {message !== undefined && <p className="mt-0.5 text-body-sm text-white/85">{message}</p>}
      </div>
      {onClose !== undefined && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="shrink-0 text-white/70 transition-colors duration-fast ease-default hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
