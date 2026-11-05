"use client";

import { ClaimStatus } from "@prisma/client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import StatusPill from "@/components/status-pill";
import { formatDate, formatMoney, humanize } from "@/lib/format";

type Claim = {
  id: string;
  status: ClaimStatus;
  claimAmount: string;
  recoveredAmount: string;
  currency: string;
  createdAt: string;
  partner: { code: string; name: string };
  exception: {
    kind: string;
    status: string;
    amountAtRisk: string;
    currency: string;
    evidenceSnapshot: Record<string, unknown>;
    result: null | {
      expectedAmount: string;
      receivedAmount: string;
      differenceAmount: string;
      currency: string;
      order: { externalId: string };
      matchedTransactions: Array<{ transaction: {
        externalReference: string | null;
        importRow: { rowNumber: number; batch: { fileName: string } };
      } }>;
    };
    financialTransaction: null | {
      externalReference: string | null;
      importRow: { rowNumber: number; batch: { fileName: string } };
    };
  };
};
type PageResponse = { claims: Claim[]; nextCursor: string | null };

export default function ClaimsWorkbench() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");

  const load = useCallback(async (cursor: string | null = null) => {
    const params = new URLSearchParams({ limit: "25" });
    if (cursor) params.set("cursor", cursor);
    if (status) params.set("status", status);
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/claims?${params}`, { cache: "no-store" });
      const body = await response.json() as PageResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load claims.");
      setError("");
      setClaims(body.claims);
      setNextCursor(body.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load claims.");
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  // Start the authenticated read on mount; updates arrive after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(null); }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCursorStack([null]);
    setLoading(true);
    void load(null);
  }
  function nextPage() {
    if (!nextCursor) return;
    setCursorStack((current) => [...current, nextCursor]);
    setLoading(true);
    void load(nextCursor);
  }
  function previousPage() {
    if (cursorStack.length <= 1) return;
    const updated = cursorStack.slice(0, -1);
    setCursorStack(updated);
    setLoading(true);
    void load(updated[updated.length - 1] ?? null);
  }
  function exportUrl() {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    return `/api/claims/export${params.size ? `?${params}` : ""}`;
  }

  return (
    <section className="table-panel">
      <div className="toolbar">
        <form className="filter-form" onSubmit={applyFilters}>
          <div className="field grow"><label className="field-label" htmlFor="claim-search">Search order or partner</label><input id="claim-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order ID, transaction reference or partner" /></div>
          <div className="field"><label className="field-label" htmlFor="claim-status">Claim status</label><select id="claim-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{Object.values(ClaimStatus).map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
          <button className="button button-secondary" type="submit">Apply</button>
          <a className="button button-primary" href={exportUrl()}>Export evidence CSV <span aria-hidden="true">↓</span></a>
        </form>
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {loading ? <div className="loading-state">Loading claims worklist…</div> : claims.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Partner / order</th><th>Case</th><th>Evidence</th><th className="numeric">Claim amount</th><th className="numeric">Recovered</th><th>Status</th><th>Opened</th><th>Detail</th></tr></thead>
            <tbody>
              {claims.map((claim) => {
                const result = claim.exception.result;
                const orderId = result?.order.externalId ?? claim.exception.financialTransaction?.externalReference ?? "Unmatched transaction";
                return (
                  <tr key={claim.id}>
                    <td><span className="table-primary">{claim.partner.name}</span><span className="table-secondary">{orderId}</span></td>
                    <td>{humanize(claim.exception.kind)}<span className="table-secondary">Exception {humanize(claim.exception.status)}</span></td>
                    <td>{result?.matchedTransactions.length ? result.matchedTransactions.map(({ transaction }) => `${transaction.importRow.batch.fileName} · row ${transaction.importRow.rowNumber}`).join(", ") : claim.exception.financialTransaction ? `${claim.exception.financialTransaction.importRow.batch.fileName} · row ${claim.exception.financialTransaction.importRow.rowNumber}` : "Calculation snapshot"}</td>
                    <td className="numeric">{formatMoney(claim.claimAmount, claim.currency)}</td>
                    <td className="numeric">{formatMoney(claim.recoveredAmount, claim.currency)}</td>
                    <td><StatusPill status={claim.status} /></td>
                    <td>{formatDate(claim.createdAt)}</td>
                    <td><button className="button button-secondary button-small" onClick={() => setExpanded(expanded === claim.id ? "" : claim.id)} aria-expanded={expanded === claim.id}>{expanded === claim.id ? "Hide" : "Evidence"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {claims.filter((claim) => claim.id === expanded).map((claim) => {
            const result = claim.exception.result;
            return (
              <div className="case-detail" key={claim.id}>
                <h3>Claim evidence · {result?.order.externalId ?? claim.exception.financialTransaction?.externalReference ?? "No order reference"}</h3>
                {result ? (
                  <>
                    <p><strong>Calculation:</strong> expected {formatMoney(result.expectedAmount, result.currency)}, received {formatMoney(result.receivedAmount, result.currency)}, difference {formatMoney(result.differenceAmount, result.currency)}.</p>
                    <p><strong>Rule explanation:</strong> {String(claim.exception.evidenceSnapshot.reason ?? "See reconciliation result for the full calculation.")}</p>
                  </>
                ) : <p>A missing order reference is retained for finance investigation and is not automatically claimed or matched.</p>}
                <p><strong>Source evidence:</strong> {result?.matchedTransactions.length ? result.matchedTransactions.map(({ transaction }) => `${transaction.importRow.batch.fileName} · row ${transaction.importRow.rowNumber}${transaction.externalReference ? ` · ${transaction.externalReference}` : ""}`).join(" | ") : claim.exception.financialTransaction ? `${claim.exception.financialTransaction.importRow.batch.fileName} · row ${claim.exception.financialTransaction.importRow.rowNumber}` : "No imported row reference available."}</p>
                <p><strong>Claim amount:</strong> {formatMoney(claim.claimAmount, claim.currency)} · <strong>Recovered:</strong> {formatMoney(claim.recoveredAmount, claim.currency)}</p>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state"><strong>No claims match this view</strong><p>Supported short-payment, past-due and freight-overcharge cases are grouped into this recovery worklist.</p></div>
      )}
      <div className="table-footer">
        <span>Page {cursorStack.length} · {claims.length} claims shown</span>
        <div className="pagination">
          <button className="button button-secondary button-small" disabled={cursorStack.length <= 1 || loading} onClick={previousPage}>Previous</button>
          <span className="pagination-label">{cursorStack.length}</span>
          <button className="button button-secondary button-small" disabled={!nextCursor || loading} onClick={nextPage}>Next</button>
        </div>
      </div>
    </section>
  );
}
