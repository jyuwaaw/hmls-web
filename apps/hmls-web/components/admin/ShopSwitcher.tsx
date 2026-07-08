"use client";
import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
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
  const { mutate } = useSWRConfig();
  const [shops, setShops] = useState<Shop[]>([]);

  useEffect(() => {
    if (!isOwner) return;
    api
      .get<Shop[]>("/api/admin/shops")
      .then(setShops)
      .catch(() => setShops([]));
  }, [isOwner, api]);

  if (!isOwner || shops.length === 0) return null;

  // Radix Select forbids an empty item value — sentinel for "all shops".
  const ALL = "__all-shops__";

  const switchShop = (value: string) => {
    setActiveShop(value === ALL ? null : value);
    // SWR keys are plain paths (no shop in the key), so cached lists would
    // keep showing the previous shop's data. The api client — and every SWR
    // fetcher closing over it — rebuilds on the next render; defer one tick so
    // revalidation runs with the NEW X-Shop-Id, then drop every cached key.
    setTimeout(() => {
      void mutate(() => true, undefined, { revalidate: true });
    }, 0);
  };

  return (
    <Select value={activeShop ?? ALL} onValueChange={switchShop}>
      <SelectTrigger className="w-44 h-8 text-xs">
        <SelectValue placeholder="All shops" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All shops</SelectItem>
        {shops.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
