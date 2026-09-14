import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string | undefined
  error?: string | undefined
  hint?: string | undefined
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, error, hint, id, required, ...props },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const messageId = error !== undefined || hint !== undefined ? `${inputId}-message` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label !== undefined && (
        <label htmlFor={inputId} className="flex gap-1 text-body-sm font-semibold text-stone-800">
          {label}
          {required && <span className="text-red-500">*</span>}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        required={required}
        aria-invalid={error !== undefined}
        aria-describedby={messageId}
        className={cn(
          'h-14 w-full rounded-md border-[1.5px] border-border bg-surface px-3.5 text-body-lg text-stone-800',
          'outline-none transition-colors duration-fast ease-default',
          'placeholder:text-stone-400',
          'focus:border-primary-600',
          'disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400',
          error !== undefined && 'border-red-500 focus:border-red-500',
          className
        )}
        {...props}
      />
      {(error !== undefined || hint !== undefined) && (
        <p id={messageId} className={cn('text-label font-normal', error !== undefined ? 'text-red-600' : 'text-stone-400')}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
})
