"use client";

import { OrderDeliveryStatus, ReconciliationStatus } from "@prisma/client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import StatusPill from "@/components/status-pill";
import { formatDate, formatMoney, humanize } from "@/lib/format";

type OrderRow = {
  id: string;
  externalId: string;
  orderDate: string;
  deliveryStatus: OrderDeliveryStatus;
  paymentMethod: string;
  orderValue: string;
  currency: string;
  channelPartner: { code: string; name: string };
  reconciliationResults: Array<{
    status: ReconciliationStatus;
    expectedAmount: string;
    receivedAmount: string;
    differenceAmount: string;
    currency: string;
    explanation: string;
  }>;
};

export default function OrdersTable() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [search, setSearch] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState("");
  const [status, setStatus] = useState("");
  const [currency, setCurrency] = useState("");
  const [sortBy, setSortBy] = useState("orderDate");
  const [sortOrder, setSortOrder] = useState("desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (nextPage = page) => {
    const params = new URLSearchParams({
      page: String(nextPage),
      limit: "25",
      sortBy,
      sortOrder,
    });
    if (search.trim()) params.set("search", search.trim());
    if (deliveryStatus) params.set("deliveryStatus", deliveryStatus);
    if (status) params.set("status", status);
    if (currency.trim()) params.set("currency", currency.trim());
    try {
      const response = await fetch(`/api/orders?${params}`, { cache: "no-store" });
      const body = await response.json() as { orders?: OrderRow[]; pageCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load orders.");
      setError("");
      setOrders(body.orders ?? []);
      setPageCount(body.pageCount ?? 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load orders.");
    } finally {
      setLoading(false);
    }
  }, [currency, deliveryStatus, page, search, sortBy, sortOrder, status]);

  // Start the authenticated read on mount; updates arrive after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setLoading(true);
    void load(1);
  }
  function sort(field: string) {
    const nextOrder = field === sortBy && sortOrder === "asc" ? "desc" : "asc";
    setSortBy(field);
    setSortOrder(nextOrder);
    setPage(1);
    setLoading(true);
  }
  function changePage(next: number) {
    setPage(next);
    setLoading(true);
    void load(next);
  }

  return (
    <section className="table-panel">
      <div className="toolbar">
        <form className="filter-form" onSubmit={applyFilters}>
          <div className="field grow"><label className="field-label" htmlFor="order-search">Search order or partner</label><input id="order-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order ID, partner name or code" /></div>
          <div className="field"><label className="field-label" htmlFor="order-status">Reconciliation</label><select id="order-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All outcomes</option>{Object.values(ReconciliationStatus).map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
          <div className="field"><label className="field-label" htmlFor="delivery-status">Delivery</label><select id="delivery-status" value={deliveryStatus} onChange={(event) => setDeliveryStatus(event.target.value)}><option value="">All delivery</option>{Object.values(OrderDeliveryStatus).map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
          <div className="field currency-field"><label className="field-label" htmlFor="order-currency">Currency</label><input id="order-currency" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="INR" maxLength={3} /></div>
          <button className="button button-secondary" type="submit">Apply</button>
        </form>
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {loading ? <div className="loading-state">Loading order ledger…</div> : orders.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th><button className="sort-button" onClick={() => sort("externalId")}>Order <span aria-hidden="true">↕</span></button></th>
                <th>Partner</th>
                <th><button className="sort-button" onClick={() => sort("orderDate")}>Order date <span aria-hidden="true">↕</span></button></th>
                <th>Delivery / payment</th>
                <th className="numeric"><button className="sort-button" onClick={() => sort("orderValue")}>Order value <span aria-hidden="true">↕</span></button></th>
                <th>Latest outcome</th>
                <th className="numeric">Expected / received</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const result = order.reconciliationResults[0];
                return (
                  <tr key={order.id}>
                    <td><span className="table-primary">{order.externalId}</span><span className="table-secondary">{order.paymentMethod}</span></td>
                    <td><span className="table-primary">{order.channelPartner.name}</span><span className="table-secondary">{order.channelPartner.code}</span></td>
                    <td>{formatDate(order.orderDate)}</td>
                    <td>{humanize(order.deliveryStatus)}<span className="table-secondary">{humanize(order.paymentMethod)}</span></td>
                    <td className="numeric">{formatMoney(order.orderValue, order.currency)}</td>
                    <td>{result ? <StatusPill status={result.status} /> : <span className="muted-note">Not reconciled</span>}</td>
                    <td className="numeric">{result ? <>{formatMoney(result.expectedAmount, result.currency)}<span className="table-secondary">received {formatMoney(result.receivedAmount, result.currency)}</span></> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state"><strong>No orders match these filters</strong><p>Clear a filter or import an order file to populate this ledger.</p></div>
      )}
      <div className="table-footer">
        <span>Newest order records first · page {page} of {Math.max(pageCount, 1)}</span>
        <div className="pagination">
          <button className="button button-secondary button-small" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}>Previous</button>
          <span className="pagination-label">{page}/{Math.max(pageCount, 1)}</span>
          <button className="button button-secondary button-small" disabled={page >= pageCount || loading} onClick={() => changePage(page + 1)}>Next</button>
        </div>
      </div>
    </section>
  );
}
