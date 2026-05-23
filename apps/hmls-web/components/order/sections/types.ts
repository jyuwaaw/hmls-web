import type { Order } from "@hmls/shared/db/types";

export type SectionProps = {
  order: Order;
  readOnly: boolean;
  /** Triggers SWR re-fetch after the section mutates the order. */
  revalidate(): void;
};
