"use client";
import { useEffect, useState } from "react";
import {
  clearActiveShop,
  readActiveShop,
  writeActiveShop,
} from "@/lib/active-shop";

export function useActiveShop(): [string | null, (id: string | null) => void] {
  const [shopId, setShopId] = useState<string | null>(null);
  useEffect(() => {
    setShopId(
      readActiveShop(
        typeof window === "undefined" ? undefined : window.localStorage,
      ),
    );
  }, []);
  const set = (id: string | null) => {
    const storage =
      typeof window === "undefined" ? undefined : window.localStorage;
    if (id === null) clearActiveShop(storage);
    else writeActiveShop(storage, id);
    setShopId(id);
  };
  return [shopId, set];
}
