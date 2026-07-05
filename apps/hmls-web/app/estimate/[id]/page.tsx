"use client";

import { Car, Check, Clock, FileText, Wrench, X as XIcon } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { FixoCtaBanner } from "@/components/FixoCtaBanner";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { AGENT_URL } from "@/lib/config";

interface LineItem {
  name: string;
  description: string;
  price: number;
}

interface EstimateReview {
  estimate: {
    id: number;
    items: LineItem[];
    subtotal: number;
    priceRangeLow: number;
    priceRangeHigh: number;
    vehicleInfo: { year?: string; make?: string; model?: string } | null;
    notes: string | null;
    expiresAt: string;
    createdAt: string;
  };
  customerName: string | null;
  orderId: number | null;
  orderStatus: string | null;
  needsAddress: boolean;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function EstimateReviewPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const token = searchParams.get("token");

  const [actionLoading, setActionLoading] = useState(false);
  const [result, setResult] = useState<"approved" | "declined" | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [showAddress, setShowAddress] = useState(false);

  const swrKey = token
    ? `${AGENT_URL}/api/estimates/${id}/review?token=${encodeURIComponent(token)}`
    : null;
  const {
    data,
    error: swrError,
    isLoading: swrLoading,
  } = useSWR<EstimateReview>(swrKey, async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message ?? "Estimate not found");
    }
    return res.json();
  });
  const error = !token
    ? "Missing token"
    : swrError instanceof Error
      ? swrError.message
      : null;
  const loading = !!swrKey && swrLoading;

  async function handleAction(action: "approve" | "decline") {
    if (!token) return;

    if (action === "decline") {
      const confirmed = await askConfirm({
        title: "Decline this estimate?",
        description: "You can always restart the chat for a new estimate.",
        confirmLabel: "Decline",
        destructive: true,
      });
      if (!confirmed) return;
    }

    const body =
      action === "approve" && addressInput.trim()
        ? { address: addressInput.trim() }
        : {};

    setActionLoading(true);
    try {
      const res = await fetch(
        `${AGENT_URL}/api/estimates/${id}/${action}?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (errBody?.error?.code === "ADDRESS_REQUIRED") {
          setShowAddress(true);
        }
        toast.error(errBody?.error?.message ?? `Failed to ${action}`);
        return;
      }
      setResult(action === "approve" ? "approved" : "declined");
    } catch {
      toast.error(`Failed to ${action} estimate`);
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-red-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <FileText className="w-12 h-12 text-text-secondary mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-text mb-2">
            Estimate Not Found
          </h1>
          <p className="text-text-secondary text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { estimate, customerName, orderStatus, needsAddress } = data;
  const items = estimate.items as LineItem[];
  const vehicle = estimate.vehicleInfo;
  const expired = new Date(estimate.expiresAt) < new Date();
  const alreadyActed =
    orderStatus !== null &&
    !["draft", "estimated", "revised"].includes(orderStatus);

  if (result) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          {result === "approved" ? (
            <>
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
              </div>
              <h1 className="text-xl font-semibold text-text mb-2">
                Estimate Approved
              </h1>
              <p className="text-text-secondary text-sm">
                We&apos;re now preparing your official quote with final pricing.
                We&apos;ll email you when it&apos;s ready.
              </p>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center mx-auto mb-4">
                <XIcon className="w-8 h-8 text-neutral-500" />
              </div>
              <h1 className="text-xl font-semibold text-text mb-2">
                Estimate Declined
              </h1>
              <p className="text-text-secondary text-sm">
                No problem. If you change your mind or need a revised estimate,
                just reply to our email or start a new chat.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <main className="max-w-lg mx-auto px-4 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text">Your Estimate</h1>
        {customerName && (
          <p className="text-text-secondary text-sm mt-1">
            Hi {customerName}, here&apos;s your service estimate.
          </p>
        )}
      </div>

      {/* Vehicle */}
      {vehicle && (vehicle.year || vehicle.make || vehicle.model) && (
        <div className="flex items-center gap-3 bg-surface border border-border rounded-xl p-4 mb-4">
          <Car className="w-5 h-5 text-text-secondary shrink-0" />
          <span className="text-sm font-medium text-text">
            {[vehicle.year, vehicle.make, vehicle.model]
              .filter(Boolean)
              .join(" ")}
          </span>
        </div>
      )}

      {/* Service items */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-text-secondary" />
            <h2 className="text-sm font-semibold text-text">Services</h2>
          </div>
        </div>
        <div className="divide-y divide-border">
          {items.map((item) => (
            <div key={item.name} className="px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">{item.name}</p>
                  {item.description && (
                    <p className="text-xs text-text-secondary mt-0.5">
                      {item.description}
                    </p>
                  )}
                </div>
                <span className="text-sm font-medium text-text whitespace-nowrap">
                  {formatCents(item.price)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing summary */}
      <div className="bg-surface border border-border rounded-xl p-4 mb-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-text-secondary">Subtotal</span>
          <span className="text-text">{formatCents(estimate.subtotal)}</span>
        </div>
        <div className="border-t border-border pt-2 mt-2">
          <div className="flex justify-between text-base font-semibold">
            <span className="text-text">Estimated Range</span>
            <span className="text-text">
              {formatCents(estimate.priceRangeLow)} &ndash;{" "}
              {formatCents(estimate.priceRangeHigh)}
            </span>
          </div>
          <p className="text-xs text-text-secondary mt-1">
            Final pricing confirmed in your official quote.
          </p>
        </div>
      </div>

      {/* Notes */}
      {estimate.notes && (
        <div className="bg-surface border border-border rounded-xl p-4 mb-4">
          <p className="text-xs text-text-secondary font-medium mb-1">Notes</p>
          <p className="text-sm text-text">{estimate.notes}</p>
        </div>
      )}

      {/* Expiry */}
      <div className="flex items-center gap-2 text-xs text-text-secondary mb-6">
        <Clock className="w-3.5 h-3.5" />
        <span>
          {expired
            ? `Expired on ${formatDate(estimate.expiresAt)}`
            : `Valid until ${formatDate(estimate.expiresAt)}`}
        </span>
      </div>

      {/* Actions */}
      {alreadyActed ? (
        <div className="text-center py-4">
          <p className="text-sm text-text-secondary">
            This estimate has already been{" "}
            {orderStatus === "approved"
              ? "approved"
              : orderStatus === "declined"
                ? "declined"
                : "processed"}
            .
          </p>
          {orderStatus === "declined" && (
            <FixoCtaBanner channelDetail="estimate_declined" />
          )}
        </div>
      ) : expired ? (
        <div className="text-center py-4">
          <p className="text-sm text-text-secondary">
            This estimate has expired. Please contact us for a new one.
          </p>
          <FixoCtaBanner channelDetail="estimate_expired" />
        </div>
      ) : (
        <div className="space-y-3">
          {showAddress && (
            <div>
              <label
                htmlFor="approve-service-address"
                className="block text-sm mb-1 text-text"
              >
                Service address (street, city, state)
              </label>
              <input
                id="approve-service-address"
                className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-surface text-text"
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                placeholder="123 Main St, San Jose, CA 95112"
              />
            </div>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                if (needsAddress && !addressInput.trim()) {
                  setShowAddress(true);
                  return;
                }
                handleAction("approve");
              }}
              disabled={actionLoading}
              className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-green-600 text-white font-semibold text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              <Check className="w-4 h-4" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => handleAction("decline")}
              disabled={actionLoading}
              className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl border border-border text-text-secondary font-medium text-sm hover:bg-surface-alt transition-colors disabled:opacity-50"
            >
              <XIcon className="w-4 h-4" />
              Decline
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
