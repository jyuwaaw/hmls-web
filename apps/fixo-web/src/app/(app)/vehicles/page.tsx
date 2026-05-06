"use client";

import { Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AddVehicleModal } from "@/components/vehicles/AddVehicleModal";
import { EmptyState } from "@/components/vehicles/EmptyState";
import { VehicleCard } from "@/components/vehicles/VehicleCard";
import { AGENT_URL } from "@/lib/config";

interface Vehicle {
  id: string;
  year: number | null;
  make: string;
  model: string;
  vin: string | null;
  nickname: string | null;
}

export default function VehiclesPage() {
  const { session } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchVehicles = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch(`${AGENT_URL}/vehicles`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setVehicles(data.vehicles ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchVehicles();
  }, [fetchVehicles]);

  const handleAdd = async (formData: {
    year: string;
    make: string;
    model: string;
    nickname: string;
  }) => {
    if (!session?.access_token || !formData.make || !formData.model) return;
    setError(null);

    try {
      const res = await fetch(`${AGENT_URL}/vehicles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          year: formData.year ? parseInt(formData.year, 10) : undefined,
          make: formData.make,
          model: formData.model,
          nickname: formData.nickname || undefined,
        }),
      });

      if (res.status === 403) {
        const data = await res.json();
        setError(data.message || "Upgrade required");
        return;
      }

      if (res.ok) {
        setShowForm(false);
        await fetchVehicles();
      }
    } catch {
      setError("Failed to add vehicle");
    }
  };

  const handleDelete = async (id: string) => {
    if (!session?.access_token) return;
    try {
      const res = await fetch(`${AGENT_URL}/vehicles/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        setVehicles((v) => v.filter((veh) => veh.id !== id));
      }
    } catch {
      // silently fail
    }
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background px-4">
        <h1 className="text-[15px] font-semibold tracking-tight">Vehicles</h1>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 pb-24">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : vehicles.length === 0 ? (
          <EmptyState onAdd={() => setShowForm(true)} />
        ) : (
          <div className="mx-auto max-w-2xl space-y-2">
            {vehicles.map((v) => (
              <VehicleCard key={v.id} vehicle={v} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <AddVehicleModal
          error={error}
          onClose={() => {
            setShowForm(false);
            setError(null);
          }}
          onAdd={handleAdd}
        />
      )}
    </div>
  );
}
