import { Field as FieldPrimitive } from '@base-ui/react/field';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Thin Base UI composition, sharing the settings form's compact spacing.
export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="field-group" className={cn('flex flex-col gap-3', className)} {...props} />
  );
}
export function Field({ className, ...props }: FieldPrimitive.Root.Props) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  );
}
export function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn('text-sm font-medium', className)}
      {...props}
    />
  );
}
