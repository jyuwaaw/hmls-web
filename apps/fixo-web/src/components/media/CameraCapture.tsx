"use client";

import { Camera, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useCamera } from "@/hooks/useCamera";

interface CameraCaptureProps {
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

export function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const {
    videoRef,
    isActive,
    startCamera,
    capturePhoto,
    stopCamera,
    switchCamera,
  } = useCamera();
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect
  useEffect(() => {
    startCamera().catch(() => {
      setError("Could not access camera. Please check permissions.");
    });
    return () => stopCamera();
  }, []);

  const handleCapture = () => {
    const photo = capturePhoto();
    if (photo) {
      setPreview(photo);
    }
  };

  const handleSend = () => {
    if (preview) {
      onCapture(preview);
      stopCamera();
      onClose();
    }
  };

  const handleRetake = () => {
    setPreview(null);
  };

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black p-6 text-white">
        <p className="mb-4 text-center text-sm">{error}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-white/20 bg-white/20 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/30"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Close button */}
      <button
        type="button"
        onClick={() => {
          stopCamera();
          onClose();
        }}
        className="absolute right-4 top-4 z-10 rounded-md border border-white/20 bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
        aria-label="Close camera"
      >
        <X className="h-5 w-5" />
      </button>

      {/* Preview or live video */}
      {preview ? (
        <div className="flex flex-1 items-center justify-center">
          {/* biome-ignore lint/performance/noImgElement: data URL from camera capture, not a static asset */}
          <img
            src={preview}
            alt="Captured"
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-cover"
          />
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-8 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4">
        {preview ? (
          <>
            <button
              type="button"
              onClick={handleRetake}
              className="rounded-md border border-white/20 bg-white/20 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/30"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={handleSend}
              className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white/90"
            >
              Send photo
            </button>
          </>
        ) : (
          <>
            <div className="w-10" />
            <button
              type="button"
              onClick={handleCapture}
              disabled={!isActive}
              className="flex h-16 w-16 items-center justify-center rounded-full border-[3px] border-white bg-white/20 transition-transform hover:scale-105 disabled:opacity-50"
              aria-label="Take photo"
            >
              <Camera className="h-6 w-6 text-white" />
            </button>
            <button
              type="button"
              onClick={switchCamera}
              className="rounded-md border border-white/20 bg-white/20 p-2.5 text-white transition-colors hover:bg-white/30"
              aria-label="Switch camera"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
