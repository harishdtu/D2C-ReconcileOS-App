"use client";

import { ExceptionKind, ExceptionStatus } from "@prisma/client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import StatusPill from "@/components/status-pill";
import { formatDate, formatMoney, humanize } from "@/lib/format";

type ExceptionRow = {
  id: string;
  kind: ExceptionKind;
  status: ExceptionStatus;
  amountAtRisk: string;
  currency: string;
  dueAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  partner: { code: string; name: string };
  result: null | {
    expectedAmount: string;
    receivedAmount: string;
    differenceAmount: string;
    explanation: string;
    order: { externalId: string };
  };
  financialTransaction: null | {
    externalReference: string | null;
    transactionDate: string;
    importRow: { rowNumber: number; batch: { fileName: string } };
  };
  claim: null | { id: string; status: string; claimAmount: string };
};
type ExceptionDetail = ExceptionRow & {
  evidenceSnapshot: Record<string, unknown>;
  result: ExceptionRow["result"] & (null | {
    matchedTransactions: Array<{ transaction: {
      externalReference: string | null;
      kind: string;
      importRow: { rowNumber: number; batch: { fileName: string } };
    } }>;
  });
  financialTransaction: ExceptionRow["financialTransaction"] & (null | {
    netAmount: string;
    grossAmount: string;
    feeAmount: string;
  });
};

const terminal = new Set<string>([ExceptionStatus.RESOLVED, ExceptionStatus.DISMISSED]);

function nextStatuses(status: ExceptionStatus): ExceptionStatus[] {
  if (status === ExceptionStatus.OPEN) {
    return [ExceptionStatus.IN_REVIEW, ExceptionStatus.RESOLVED, ExceptionStatus.DISMISSED];
  }
  if (status === ExceptionStatus.IN_REVIEW) {
    return [ExceptionStatus.OPEN, ExceptionStatus.RESOLVED, ExceptionStatus.DISMISSED];
  }
  return [];
}

export default function ExceptionsWorkbench() {
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [detail, setDetail] = useState<ExceptionDetail | null>(null);
  const [detailId, setDetailId] = useState("");
  const [resolution, setResolution] = useState<Record<string, { status: string; note: string }>>({});
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (nextPage = page) => {
    const params = new URLSearchParams({ page: String(nextPage), limit: "25" });
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (kind) params.set("kind", kind);
    try {
      const response = await fetch(`/api/exceptions?${params}`, { cache: "no-store" });
      const body = await response.json() as { exceptions?: ExceptionRow[]; pageCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load exceptions.");
      setError("");
      setExceptions(body.exceptions ?? []);
      setPageCount(body.pageCount ?? 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load exceptions.");
    } finally {
      setLoading(false);
    }
  }, [kind, page, search, status]);

  // Start the authenticated read on mount; updates arrive after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function showDetails(id: string) {
    if (detailId === id) {
      setDetailId("");
      setDetail(null);
      return;
    }
    setDetailId(id);
    setDetail(null);
    setError("");
    try {
      const response = await fetch(`/api/exceptions/${id}`, { cache: "no-store" });
      const body = await response.json() as ExceptionDetail & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load exception evidence.");
      setDetail(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load exception evidence.");
      setDetailId("");
    }
  }

  function updateResolution(id: string, value: Partial<{ status: string; note: string }>) {
    setResolution((current) => ({
      ...current,
      [id]: {
        status: current[id]?.status ?? "",
        note: current[id]?.note ?? "",
        ...value,
      },
    }));
  }

  async function applyTransition(event: FormEvent<HTMLFormElement>, item: ExceptionRow) {
    event.preventDefault();
    const selected = resolution[item.id];
    if (!selected?.status) return;
    setWorkingId(item.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/exceptions/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: selected.status, resolutionNote: selected.note }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update exception.");
      setMessage(`Exception ${item.id.slice(0, 8)} moved to ${humanize(selected.status)}.`);
      await load();
      if (detailId === item.id) await showDetails(item.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update exception.");
    } finally {
      setWorkingId("");
    }
  }

  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setLoading(true);
    void load(1);
  }
  function changePage(next: number) {
    setPage(next);
    setLoading(true);
    void load(next);
  }

  return (
    <section className="table-panel">
      {message ? <div className="notice" role="status">{message}</div> : null}
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <div className="toolbar">
        <form className="filter-form" onSubmit={filter}>
          <div className="field grow"><label className="field-label" htmlFor="exception-search">Search case, order or partner</label><input id="exception-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order ID, transaction reference, partner" /></div>
          <div className="field"><label className="field-label" htmlFor="exception-status">Status</label><select id="exception-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{Object.values(ExceptionStatus).map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
          <div className="field"><label className="field-label" htmlFor="exception-kind">Exception type</label><select id="exception-kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All types</option>{Object.values(ExceptionKind).map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
          <button className="button button-secondary" type="submit">Apply</button>
        </form>
      </div>
      {loading ? <div className="loading-state">Loading exception register…</div> : exceptions.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Case / partner</th><th>Reference</th><th>Type</th><th className="numeric">At risk</th><th>Status</th><th>Evidence</th><th>Review action</th></tr></thead>
            <tbody>
              {exceptions.map((item) => {
                const state = resolution[item.id] ?? { status: "", note: "" };
                const reference = item.result?.order.externalId ?? item.financialTransaction?.externalReference ?? "No order reference";
                return (
                  <tr key={item.id}>
                    <td><span className="table-primary">{item.partner.name}</span><span className="table-secondary">Case {item.id.slice(0, 8)} · {formatDate(item.createdAt)}</span></td>
                    <td><span className="table-primary">{reference}</span>{item.financialTransaction ? <span className="table-secondary">{item.financialTransaction.importRow.batch.fileName} · row {item.financialTransaction.importRow.rowNumber}</span> : null}</td>
                    <td><span>{humanize(item.kind)}</span>{item.claim ? <span className="table-secondary">Claim {humanize(item.claim.status)}</span> : null}</td>
                    <td className="numeric">{formatMoney(item.amountAtRisk, item.currency)}</td>
                    <td><StatusPill status={item.status} /></td>
                    <td><button className="button button-secondary button-small" onClick={() => void showDetails(item.id)} aria-expanded={detailId === item.id}>{detailId === item.id ? "Hide" : "Inspect"}</button></td>
                    <td>
                      {nextStatuses(item.status).length ? (
                        <form className="review-form" onSubmit={(event) => void applyTransition(event, item)}>
                          <select aria-label={`Next status for case ${item.id.slice(0, 8)}`} value={state.status} onChange={(event) => updateResolution(item.id, { status: event.target.value })} required>
                            <option value="">Choose action</option>{nextStatuses(item.status).map((next) => <option key={next} value={next}>{humanize(next)}</option>)}
                          </select>
                          {state.status && terminal.has(state.status as ExceptionStatus) ? (
                            <input aria-label="Resolution note" value={state.note} onChange={(event) => updateResolution(item.id, { note: event.target.value })} placeholder="Resolution note (10+ chars)" maxLength={4000} required />
                          ) : null}
                          <button className="button button-primary button-small" disabled={workingId === item.id || !state.status}>{workingId === item.id ? "Saving…" : "Save"}</button>
                        </form>
                      ) : <span className="muted-note">Closed · final state</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {detailId ? (
            <div className="case-detail">
              {!detail ? <p>Loading evidence…</p> : (
                <>
                  <h3>Evidence · {detail.result?.order.externalId ?? detail.financialTransaction?.externalReference ?? "Unmatched transaction"}</h3>
                  {detail.result ? <p>{detail.result.explanation}</p> : null}
                  {detail.result ? <p><strong>Reconciliation:</strong> expected {formatMoney(detail.result.expectedAmount, detail.currency)}, received {formatMoney(detail.result.receivedAmount, detail.currency)}, difference {formatMoney(detail.result.differenceAmount, detail.currency)}.</p> : null}
                  {detail.result?.matchedTransactions.length ? <p><strong>Source rows:</strong> {detail.result.matchedTransactions.map(({ transaction }) => `${transaction.kind} · ${transaction.importRow.batch.fileName} · row ${transaction.importRow.rowNumber}${transaction.externalReference ? ` · ${transaction.externalReference}` : ""}`).join(" | ")}</p> : null}
                  {detail.financialTransaction ? <p><strong>Unmatched source:</strong> {detail.financialTransaction.importRow.batch.fileName} · row {detail.financialTransaction.importRow.rowNumber} · net {formatMoney(detail.financialTransaction.netAmount, detail.currency)}.</p> : null}
                  {detail.resolutionNote ? <p><strong>Last resolution note:</strong> {detail.resolutionNote}</p> : null}
                  <p><strong>Case opened:</strong> {formatDate(detail.createdAt)}{detail.dueAt ? ` · due ${formatDate(detail.dueAt)}` : ""}</p>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="empty-state"><strong>No exceptions found</strong><p>Unmatched records and supported settlement or freight differences will appear here after reconciliation.</p></div>
      )}
      <div className="table-footer">
        <span>{exceptions.length} cases shown · page {page} of {Math.max(pageCount, 1)}</span>
        <div className="pagination">
          <button className="button button-secondary button-small" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}>Previous</button>
          <span className="pagination-label">{page}/{Math.max(pageCount, 1)}</span>
          <button className="button button-secondary button-small" disabled={page >= pageCount || loading} onClick={() => changePage(page + 1)}>Next</button>
        </div>
      </div>
    </section>
  );
}
