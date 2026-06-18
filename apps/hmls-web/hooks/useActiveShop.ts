"use client";
import { useEffect, useState } from "react";
import { readActiveShop, writeActiveShop } from "@/lib/active-shop";

export function useActiveShop(): [string | null, (id: string) => void] {
  const [shopId, setShopId] = useState<string | null>(null);
  useEffect(() => {
    setShopId(
      readActiveShop(
        typeof window === "undefined" ? undefined : window.localStorage,
      ),
    );
  }, []);
  const set = (id: string) => {
    writeActiveShop(
      typeof window === "undefined" ? undefined : window.localStorage,
      id,
    );
    setShopId(id);
  };
  return [shopId, set];
}
