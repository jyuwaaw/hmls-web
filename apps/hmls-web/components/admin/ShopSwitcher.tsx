"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Shop = { id: string; name: string; slug: string };

export function ShopSwitcher() {
  const { isOwner, api, activeShop, setActiveShop } = useAuth();
  const [shops, setShops] = useState<Shop[]>([]);

  useEffect(() => {
    if (!isOwner) return;
    api
      .get<Shop[]>("/api/admin/shops")
      .then(setShops)
      .catch(() => setShops([]));
  }, [isOwner, api]);

  if (!isOwner || shops.length === 0) return null;

  return (
    <Select value={activeShop ?? ""} onValueChange={setActiveShop}>
      <SelectTrigger className="w-44 h-8 text-xs">
        <SelectValue placeholder="All shops" />
      </SelectTrigger>
      <SelectContent>
        {shops.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
