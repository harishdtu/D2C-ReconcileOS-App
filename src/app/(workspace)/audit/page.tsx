"use client";

import PageHeading from "@/components/page-heading";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatDate } from "@/lib/format";

type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor: { email: string; role: string } | null;
};

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [action, setAction] = useState("");
  const [submittedAction, setSubmittedAction] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (nextPage = page, filterAction = submittedAction) => {
    const params = new URLSearchParams({ page: String(nextPage), limit: "25" });
    if (filterAction.trim()) params.set("action", filterAction.trim());
    try {
      const response = await fetch(`/api/audit?${params}`, { cache: "no-store" });
      const body = await response.json() as { events?: AuditEvent[]; pageCount?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load audit history.");
      setError("");
      setEvents(body.events ?? []);
      setPageCount(body.pageCount ?? 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load audit history.");
    } finally {
      setLoading(false);
    }
  }, [page, submittedAction]);

  // Start the authenticated read on mount; updates arrive after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setLoading(true);
    setSubmittedAction(action);
    void load(1, action);
  }
  function changePage(next: number) {
    setPage(next);
    setLoading(true);
    void load(next);
  }

  return (
    <>
      <PageHeading
        eyebrow="ACCOUNTABILITY"
        title="Audit trail"
        description="A read-only record of imports, mapping approvals, reconciliation runs and exception decisions."
      />
      <section className="table-panel">
        <div className="toolbar">
          <form className="filter-form" onSubmit={filter}>
            <div className="field grow"><label className="field-label" htmlFor="audit-action">Filter by action</label><input id="audit-action" value={action} onChange={(event) => setAction(event.target.value)} placeholder="Import, mapping, reconciliation…" /></div>
            <button className="button button-secondary" type="submit">Apply</button>
          </form>
        </div>
        {error ? <div className="alert" role="alert">{error}</div> : null}
        {loading ? <div className="loading-state">Loading audit events…</div> : events.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Activity</th><th>Entity</th><th>Record</th><th>Actor</th><th>When</th></tr></thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td><span className="table-primary">{event.action.replaceAll("_", " ")}</span></td>
                    <td>{event.entityType}</td>
                    <td className="mono-id">{event.entityId}</td>
                    <td>{event.actor?.email ?? "System"}<span className="table-secondary">{event.actor?.role.replaceAll("_", " ") ?? "Automated"}</span></td>
                    <td>{formatDate(event.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-state"><strong>No audit events found</strong><p>Important financial operations are recorded here as they occur.</p></div>}
        <div className="table-footer">
          <span>{events.length} events shown · page {page} of {Math.max(pageCount, 1)}</span>
          <div className="pagination">
            <button className="button button-secondary button-small" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}>Previous</button>
            <span className="pagination-label">{page}/{Math.max(pageCount, 1)}</span>
            <button className="button button-secondary button-small" disabled={page >= pageCount || loading} onClick={() => changePage(page + 1)}>Next</button>
          </div>
        </div>
      </section>
    </>
  );
}
