import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'accent'
type ButtonSize = 'sm' | 'md' | 'lg'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary-600 text-white hover:bg-primary-700',
  secondary: 'bg-surface text-stone-800 border-2 border-border hover:bg-stone-50',
  ghost: 'bg-transparent text-stone-500 hover:bg-stone-100',
  destructive: 'bg-red-500 text-white hover:bg-red-600',
  accent: 'bg-accent-500 text-white hover:bg-accent-600'
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-4 text-body-sm rounded-md',
  md: 'h-12 px-6 text-body rounded-lg',
  lg: 'h-14 px-7 text-body-lg rounded-lg'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', fullWidth = false, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold tracking-[-0.01em]',
        'transition-all duration-fast ease-default active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    />
  )
})
