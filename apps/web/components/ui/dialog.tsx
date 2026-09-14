'use client'

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-[700] bg-stone-900/40', className)}
      {...props}
    />
  )
})

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed inset-y-0 right-0 z-[710] flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface shadow-xl',
          'focus:outline-none',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Fermer"
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-md text-stone-500 transition-colors duration-fast ease-default hover:bg-stone-100"
        >
          <X className="h-5 w-5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('border-b border-border px-6 py-5', className)} {...props} />
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('text-h3 font-bold text-stone-800', className)} {...props} />
})
