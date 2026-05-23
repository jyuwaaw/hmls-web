"use client";

import { ExternalLink, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function PdfPreviewDialog({
  open,
  onOpenChange,
  pdfUrl,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pdfUrl: string;
  title: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl h-[90vh] p-0 gap-0">
        <DialogHeader className="px-4 py-2 border-b">
          <div className="flex items-center justify-between w-full">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const w = window.open(pdfUrl, "_blank");
                  if (w) w.addEventListener("load", () => w.print());
                }}
              >
                <Printer className="w-3 h-3" /> Print
              </Button>
              <Button variant="ghost" size="xs" asChild>
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-3 h-3" /> Open
                </a>
              </Button>
            </div>
          </div>
        </DialogHeader>
        <iframe src={pdfUrl} className="w-full flex-1" title={title} />
      </DialogContent>
    </Dialog>
  );
}
