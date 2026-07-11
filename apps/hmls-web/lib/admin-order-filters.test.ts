import { describe, expect, test } from "bun:test";
import {
  getAdminOrderDetailHref,
  getAdminOrdersListHref,
  parseAdminOrdersFilter,
  parseAdminOrdersSearch,
} from "./admin-order-filters";

describe("admin order filter URL helpers", () => {
  test("parses only supported order status filters", () => {
    expect(parseAdminOrdersFilter("draft")).toBe("draft");
    expect(parseAdminOrdersFilter("in_progress")).toBe("in_progress");
    expect(parseAdminOrdersFilter("cancelled")).toBe("cancelled");
    expect(parseAdminOrdersFilter(null)).toBe("");
    expect(parseAdminOrdersFilter("unknown")).toBe("");
  });

  test("retired statuses from old bookmarks fall back to All", () => {
    // 9→7 collapse: scheduled/revised are no longer filterable states.
    expect(parseAdminOrdersFilter("scheduled")).toBe("");
    expect(parseAdminOrdersFilter("revised")).toBe("");
  });

  test("trims search input and treats blank as empty", () => {
    expect(parseAdminOrdersSearch(null)).toBe("");
    expect(parseAdminOrdersSearch("  ")).toBe("");
    expect(parseAdminOrdersSearch(" brake ")).toBe("brake");
  });

  test("builds list hrefs with filter state in the URL", () => {
    expect(getAdminOrdersListHref("")).toBe("/admin/orders");
    expect(getAdminOrdersListHref("draft")).toBe("/admin/orders?status=draft");
    expect(getAdminOrdersListHref("in_progress")).toBe(
      "/admin/orders?status=in_progress",
    );
  });

  test("merges filter and search into the list href", () => {
    expect(getAdminOrdersListHref("", "brake")).toBe(
      "/admin/orders?search=brake",
    );
    expect(getAdminOrdersListHref("draft", "brake noise")).toBe(
      "/admin/orders?status=draft&search=brake+noise",
    );
    expect(getAdminOrdersListHref("draft", "  ")).toBe(
      "/admin/orders?status=draft",
    );
  });

  test("carries the active filter into order detail links", () => {
    expect(getAdminOrderDetailHref(380, "")).toBe("/admin/orders/380");
    expect(getAdminOrderDetailHref(380, "draft")).toBe(
      "/admin/orders/380?fromStatus=draft",
    );
    expect(getAdminOrderDetailHref(380, "cancelled")).toBe(
      "/admin/orders/380?fromStatus=cancelled",
    );
  });

  test("carries filter and search into order detail links", () => {
    expect(getAdminOrderDetailHref(380, "draft", "brake")).toBe(
      "/admin/orders/380?fromStatus=draft&search=brake",
    );
    expect(getAdminOrderDetailHref(380, "", "brake")).toBe(
      "/admin/orders/380?search=brake",
    );
  });
});
