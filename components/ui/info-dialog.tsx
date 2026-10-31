"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./dialog";

/** Keep optional help in one consistent, keyboard-accessible place. */
export function InfoDialog({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Dialog>
    <DialogTrigger render={<Button variant="ghost" size="icon-sm" className="info-button" aria-label={title} title={title} />}><Info size={17} /></DialogTrigger>
    <DialogContent className="info-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
      <div className="info-dialog-body">{children}</div>
    </DialogContent>
  </Dialog>;
}
