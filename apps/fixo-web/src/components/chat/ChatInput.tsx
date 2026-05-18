"use client";

import { Camera, Cpu, ImagePlus, Mic, Send } from "lucide-react";
import { type RefObject, useRef, useState } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
  onCameraClick?: () => void;
  onMicClick?: () => void;
  onObdClick?: () => void;
  onFilePick?: (file: File) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Vercel chatbot-template-style composer:
 *  - Single rounded card containing textarea + tool icon row + send button.
 *  - Hairline border, no shadow, focus ring uses --ring (Fixo Blue accent).
 *  - Icon row sits below the textarea — same layout as v0/Vercel chat templates.
 *  - Send button is a black/white inverted square (primary), accent only when
 *    enabled-and-non-empty so the eye is drawn to a real action target.
 */
export function ChatInput({
  onSend,
  isLoading,
  onCameraClick,
  onMicClick,
  onObdClick,
  onFilePick,
  inputRef,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canSend = value.trim().length > 0 && !isLoading;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter sends, Shift+Enter for newline (matches Vercel chatbot UX)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-3 lg:left-60 lg:pb-4">
      {/* Soft gradient fade replaces a hard border-t — content scrolls
          *under* the input area and softly disappears, instead of being
          "cut" by a 1px line. Matches Vercel chatbot composer. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-background to-background/0"
      />
      <form
        onSubmit={handleSubmit}
        className="relative mx-auto flex max-w-2xl items-end gap-1.5 rounded-xl border border-border bg-background p-1.5 transition-colors focus-within:border-foreground/25"
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe your car problem…"
          disabled={isLoading}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-50"
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && onFilePick) onFilePick(file);
            e.target.value = "";
          }}
        />

        <div className="flex items-center gap-px">
          <ToolButton onClick={onCameraClick} label="Take photo">
            <Camera className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton
            onClick={() => fileInputRef.current?.click()}
            label="Upload photo"
          >
            <ImagePlus className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton onClick={onMicClick} label="Record audio">
            <Mic className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton onClick={onObdClick} label="Enter OBD code">
            <Cpu className="h-3.5 w-3.5" />
          </ToolButton>

          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/70"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}

function ToolButton({
  onClick,
  label,
  children,
}: {
  onClick?: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
