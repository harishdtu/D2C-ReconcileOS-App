"use client";

import { ReconciliationRunStatus, ReconciliationStatus } from "@prisma/client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import StatusPill from "@/components/status-pill";
import { formatDate, formatMoney, humanize } from "@/lib/format";

type Batch = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number | null;
  source: { kind: string; partner: { name: string } };
};
type Run = {
  id: string;
  status: ReconciliationRunStatus;
  rulesVersion: string;
  startedAt: string;
  completedAt: string | null;
  initiatedBy: { email: string };
  _count: { results: number };
};
type Result = {
  id: string;
  status: ReconciliationStatus;
  expectedAmount: string;
  receivedAmount: string;
  differenceAmount: string;
  currency: string;
  reasonCodes: unknown;
  explanation: string;
  createdAt: string;
  order: {
    externalId: string;
    orderValue: string;
    deliveryStatus: string;
    paymentMethod: string;
    channelPartner: { code: string; name: string };
  };
  matchedTransactions: Array<{ transaction: {
    kind: string;
    externalReference: string | null;
    transactionDate: string;
    netAmount: string;
    currency: string;
  } }>;
  exceptions: Array<{
    id: string;
    kind: string;
    status: string;
    amountAtRisk: string;
    currency: string;
  }>;
};

const resultStatuses = Object.values(ReconciliationStatus);

export default function ReconciliationWorkbench() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedBatches, setSelectedBatches] = useState<string[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [expandedResult, setExpandedResult] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadRuns = useCallback(async () => {
    const response = await fetch("/api/reconciliation?limit=100", { cache: "no-store" });
    const body = await response.json() as { runs?: Run[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load reconciliation runs.");
    return body.runs ?? [];
  }, []);

  const loadBatches = useCallback(async () => {
    const response = await fetch("/api/imports?status=COMPLETED&limit=100", { cache: "no-store" });
    const body = await response.json() as { batches?: Batch[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load completed imports.");
    return body.batches ?? [];
  }, []);

  const loadResults = useCallback(async (
    runId: string,
    nextPage: number,
    nextSearch: string,
    nextStatus: string,
  ) => {
    if (!runId) return;
    const params = new URLSearchParams({ runId, page: String(nextPage), limit: "25" });
    if (nextSearch.trim()) params.set("search", nextSearch.trim());
    if (nextStatus) params.set("status", nextStatus);
    try {
      const response = await fetch(`/api/reconciliation?${params}`, { cache: "no-store" });
      const body = await response.json() as { results?: Result[]; pageCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load reconciliation results.");
      setError("");
      setResults(body.results ?? []);
      setPageCount(body.pageCount ?? 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load results.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load persisted runs and completed import batches after mount.
  useEffect(() => {
    let active = true;
    Promise.all([loadRuns(), loadBatches()])
      .then(([loadedRuns, loadedBatches]) => {
        if (!active) return;
        setRuns(loadedRuns);
        setBatches(loadedBatches);
        const latest = loadedRuns[0];
        if (latest) setSelectedRunId(latest.id);
        else setLoading(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Could not load reconciliation.");
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [loadBatches, loadRuns]);

  // Refresh results when the active run or server-side filters change.
  useEffect(() => {
    if (selectedRunId) {
      // The async request updates results only after its network response.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadResults(selectedRunId, page, search, status);
    }
  }, [selectedRunId, loadResults, page, search, status]);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId), [runs, selectedRunId]);
  function toggleBatch(id: string) {
    setSelectedBatches((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function runSelected() {
    if (!selectedBatches.length) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/reconciliation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchIds: selectedBatches }),
      });
      const body = await response.json() as { runId?: string; idempotentReplay?: boolean; resultCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Reconciliation failed.");
      if (!body.runId) throw new Error("The reconciliation completed without a run reference.");
      setMessage(body.idempotentReplay
        ? "These exact inputs were already reconciled; showing the existing run."
        : `Reconciliation completed with ${(body.resultCount ?? 0).toLocaleString("en-IN")} order results.`);
      const updatedRuns = await loadRuns();
      setRuns(updatedRuns);
      setSelectedRunId(body.runId);
      setSelectedBatches([]);
      if (!updatedRuns.some((run) => run.id === body.runId)) {
        await loadRuns();
      }
      await loadResults(body.runId, 1, search, status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Reconciliation failed.");
    } finally {
      setWorking(false);
    }
  }

  function filterResults(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setLoading(true);
    void loadResults(selectedRunId, 1, search, status);
  }
  function changePage(next: number) {
    setPage(next);
    setLoading(true);
    void loadResults(selectedRunId, next, search, status);
  }

  return (
    <div className="reconciliation-layout">
      <section className="panel" aria-labelledby="run-inputs-title">
        <div className="panel-heading">
          <div><h2 id="run-inputs-title">Run reconciliation</h2><p>Select completed imports to compare against persisted orders and financial records.</p></div>
          <span className="metric-mark" aria-hidden="true">↔</span>
        </div>
        {batches.length ? (
          <div className="batch-select-list">
            {batches.map((batch) => (
              <label className="batch-select-row" key={batch.id}>
                <input type="checkbox" checked={selectedBatches.includes(batch.id)} onChange={() => toggleBatch(batch.id)} disabled={working} />
                <span className="batch-select-copy"><strong>{batch.source.partner.name} · {humanize(batch.source.kind)}</strong><small>{batch.fileName} · {batch.totalRows?.toLocaleString("en-IN") ?? 0} rows</small></span>
                <StatusPill status={batch.status} />
              </label>
            ))}
          </div>
        ) : (
          <div className="empty-state"><strong>No completed imports to reconcile</strong><p>Upload and approve an order, settlement, COD-remittance or freight-invoice file first.</p></div>
        )}
        <div className="run-controls">
          <span className="muted-note">{selectedBatches.length} batch{selectedBatches.length === 1 ? "" : "es"} selected · identical input reruns are idempotent</span>
          <button className="button button-primary" onClick={() => void runSelected()} disabled={!selectedBatches.length || working}>{working ? "Reconciling…" : "Run reconciliation"}</button>
        </div>
      </section>

      {message ? <div className="notice" role="status">{message}</div> : null}
      {error ? <div className="alert" role="alert">{error}</div> : null}

      <section className="panel section-spacer" aria-labelledby="results-title">
        <div className="panel-heading">
          <div><h2 id="results-title">Reconciliation results</h2><p>Every outcome includes the rule explanation and transaction evidence.</p></div>
          <div className="run-selector">
            <label className="field-label" htmlFor="run-select">Run</label>
            <select id="run-select" value={selectedRunId} onChange={(event) => { setSelectedRunId(event.target.value); setPage(1); }}>
              <option value="">Select a run</option>
              {runs.map((run) => <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · {run.id.slice(0, 8)} · {humanize(run.status)}</option>)}
            </select>
          </div>
        </div>
        <div className="run-context">
          {selectedRun ? <><StatusPill status={selectedRun.status} /><span>{selectedRun._count.results.toLocaleString("en-IN")} results · {selectedRun.rulesVersion} · started by {selectedRun.initiatedBy.email}</span></> : <span className="muted-note">Choose a completed run to inspect its outcomes.</span>}
        </div>
        <div className="toolbar">
          <form className="filter-form" onSubmit={filterResults}>
            <div className="field grow"><label className="field-label" htmlFor="result-search">Search order or partner</label><input id="result-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order ID or channel partner" /></div>
            <div className="field"><label className="field-label" htmlFor="result-status">Outcome</label><select id="result-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All outcomes</option>{resultStatuses.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></div>
            <button className="button button-secondary" type="submit" disabled={!selectedRunId}>Apply</button>
          </form>
        </div>
        {loading ? <div className="loading-state">Loading reconciliation results…</div> : results.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Order / partner</th><th>Outcome</th><th className="numeric">Expected</th><th className="numeric">Received</th><th className="numeric">Difference</th><th>Evidence</th></tr></thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.id}>
                    <td><span className="table-primary">{result.order.externalId}</span><span className="table-secondary">{result.order.channelPartner.name}</span></td>
                    <td><StatusPill status={result.status} /></td>
                    <td className="numeric">{formatMoney(result.expectedAmount, result.currency)}</td>
                    <td className="numeric">{formatMoney(result.receivedAmount, result.currency)}</td>
                    <td className={`numeric${result.differenceAmount.startsWith("-") ? " amount-negative" : ""}`}>{formatMoney(result.differenceAmount, result.currency)}</td>
                    <td><button className="button button-secondary button-small" onClick={() => setExpandedResult(expandedResult === result.id ? "" : result.id)} aria-expanded={expandedResult === result.id}>{expandedResult === result.id ? "Hide details" : "Why?"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {results.filter((result) => result.id === expandedResult).map((result) => (
              <div className="case-detail" key={result.id}>
                <h3>Rule explanation · {result.order.externalId}</h3>
                <p>{result.explanation}</p>
                <p><strong>Reason codes:</strong> {Array.isArray(result.reasonCodes) ? result.reasonCodes.map(String).join(", ") || "None" : "Recorded"}</p>
                <p><strong>Compared records:</strong> {result.matchedTransactions.length ? result.matchedTransactions.map(({ transaction }) => `${humanize(transaction.kind)}${transaction.externalReference ? ` · ${transaction.externalReference}` : ""} · ${formatMoney(transaction.netAmount, transaction.currency)}`).join(" | ") : "No financial transaction was linked to this order."}</p>
                {result.exceptions.length ? <p><strong>Exceptions:</strong> {result.exceptions.map((item) => `${humanize(item.kind)} (${humanize(item.status)}) · ${formatMoney(item.amountAtRisk, item.currency)}`).join(" | ")}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state"><strong>{selectedRunId ? "No results match this view" : "No run selected"}</strong><p>{selectedRunId ? "Try another status or search term." : "Select completed batches above to begin, or choose an existing run."}</p></div>
        )}
        <div className="table-footer">
          <span>{selectedRun ? `${selectedRun._count.results.toLocaleString("en-IN")} total results` : "No result set"} · page {page} of {Math.max(pageCount, 1)}</span>
          <div className="pagination">
            <button className="button button-secondary button-small" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}>Previous</button>
            <span className="pagination-label">{page}/{Math.max(pageCount, 1)}</span>
            <button className="button button-secondary button-small" disabled={page >= pageCount || loading} onClick={() => changePage(page + 1)}>Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
