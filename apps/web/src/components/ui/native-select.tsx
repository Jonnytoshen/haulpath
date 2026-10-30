import * as React from 'react';
import { cn } from '@/lib/utils';
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) { return <select data-slot="native-select" className={cn('h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />; }
