import { cn } from '@/lib/utils';
import Image from 'next/image';

type BrandLogoProps = { variant?: 'lockup' | 'mark'; className?: string };

export function BrandLogo({ variant = 'lockup', className }: BrandLogoProps) {
  const mark = variant === 'mark';
  return (
    <Image
      unoptimized
      src={mark ? '/brand/haulpath-mark.svg' : '/brand/haulpath-lockup.svg'}
      width={mark ? 100 : 470}
      height={mark ? 100 : 156}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('brand-logo', mark ? 'brand-logo-mark' : 'brand-logo-lockup', className)}
    />
  );
}
