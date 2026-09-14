import { forwardRef, useId, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string | undefined
  error?: string | undefined
  hint?: string | undefined
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, label, error, hint, id, required, rows = 3, ...props },
  ref
) {
  const generatedId = useId()
  const textareaId = id ?? generatedId
  const messageId = error !== undefined || hint !== undefined ? `${textareaId}-message` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label !== undefined && (
        <label htmlFor={textareaId} className="flex gap-1 text-body-sm font-semibold text-stone-800">
          {label}
          {required && <span className="text-red-500">*</span>}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        required={required}
        rows={rows}
        aria-invalid={error !== undefined}
        aria-describedby={messageId}
        className={cn(
          'w-full resize-none rounded-md border-[1.5px] border-border bg-surface px-3.5 py-3 text-body-lg text-stone-800',
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
