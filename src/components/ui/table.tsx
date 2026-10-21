import * as React from 'react';
import { cn } from '@/lib/utils';
export function Table({ className, ...props }: React.ComponentProps<'table'>) { return <table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} />; }
export function TableHeader(props: React.ComponentProps<'thead'>) { return <thead data-slot="table-header" {...props} />; }
export function TableBody(props: React.ComponentProps<'tbody'>) { return <tbody data-slot="table-body" {...props} />; }
export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) { return <tr data-slot="table-row" className={cn('border-b transition-colors hover:bg-muted/50', className)} {...props} />; }
export function TableHead({ className, ...props }: React.ComponentProps<'th'>) { return <th data-slot="table-head" className={cn('h-10 px-3 text-left align-middle font-medium text-muted-foreground', className)} {...props} />; }
export function TableCell({ className, ...props }: React.ComponentProps<'td'>) { return <td data-slot="table-cell" className={cn('p-3 align-middle', className)} {...props} />; }
