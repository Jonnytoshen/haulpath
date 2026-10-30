'use client';

import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogRoot, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

export function Dialog({ title, children, onClose, wide = false, error, description }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; error?: string; description?: string }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <DialogRoot open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className={wide ? 'max-w-4xl' : ''} onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={(event) => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}><div className="dialog-title"><DialogTitle>{title}</DialogTitle><Button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X /></Button></div><DialogDescription className="sr-only">{description ?? `${title}，填写内容并确认保存。`}</DialogDescription>{error && <p className="message error" role="alert">{error}</p>}{children}</DialogContent></DialogRoot>;
}
