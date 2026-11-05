"use client";

import { useCallback, useEffect, useState } from "react";
import StatusPill from "@/components/status-pill";
import { formatDate, formatMoney } from "@/lib/format";

type Candidate = {
  id: string;
  confidence: string | null;
  reason: string;
  createdAt: string;
  transaction: {
    id: string;
    kind: string;
    externalReference: string | null;
    transactionDate: string;
    currency: string;
    grossAmount: string;
    netAmount: string;
    alternatives: number;
    partner: { code: string; name: string };
    importRow: { rowNumber: number; batch: { fileName: string } };
  };
  candidateOrder: {
    id: string;
    externalId: string;
    orderDate: string;
    orderValue: string;
    currency: string;
    channelPartner: { code: string; name: string };
  };
};

type CandidatePage = {
  candidates: Candidate[];
  page: number;
  pageCount: number;
  total: number;
};

export default function MatchReviewWorkbench({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<CandidatePage | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState("");
  const [generationCursor, setGenerationCursor] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (nextPage = page) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/match-suggestions?page=${nextPage}&limit=25`, {
        cache: "no-store",
      });
      const body = await response.json() as CandidatePage & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load match candidates.");
      setData(body);
      setPage(nextPage);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load match candidates.");
    } finally {
      setLoading(false);
    }
  }, [page]);

  // Load the authenticated review queue when the screen opens.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(1); }, [load]);

  async function generate() {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/match-suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(generationCursor ? { afterId: generationCursor } : {}),
      });
      const body = await response.json() as {
        transactionsReviewed?: number;
        candidatesCreated?: number;
        transactionsWithoutCandidates?: number;
        tooAmbiguousTransactions?: number;
        nextCursor?: string | null;
        limitReached?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Candidate generation failed.");
      setGenerationCursor(body.nextCursor ?? "");
      setMessage(
        `Reviewed ${body.transactionsReviewed ?? 0} unmatched transactions; created ${body.candidatesCreated ?? 0} candidate suggestions; ${body.transactionsWithoutCandidates ?? 0} had no supported candidate; ${body.tooAmbiguousTransactions ?? 0} were too ambiguous to list safely.${body.limitReached ? " Continue to process the next bounded batch." : ""}`,
      );
      await load(1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Candidate generation failed.");
    } finally {
      setWorking(false);
    }
  }

  async function decide(candidate: Candidate, decision: "accept" | "reject") {
    if (decision === "accept" && confirming !== candidate.id) {
      setConfirming(candidate.id);
      return;
    }
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/match-suggestions/${candidate.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision === "accept"
          ? { decision, confirmed: true }
          : { decision }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save the match decision.");
      setConfirming("");
      setMessage(decision === "accept"
        ? `Transaction linked to order ${candidate.candidateOrder.externalId}. Other candidates for this transaction were closed; the reconciliation case remains open for review.`
        : "Candidate rejected. No financial record was changed.");
      await load(page);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the match decision.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="table-panel">
      <div className="toolbar">
        <p className="muted-note">Candidates require an exact currency and date-window check plus an exact source-reference or amount signal. Signal strength is a deterministic ranking, not a probability.</p>
        {canManage ? (
          <button className="button button-primary" type="button" onClick={generate} disabled={working}>
            {working ? "Reviewing unmatched transactions…" : generationCursor ? "Continue candidate generation" : "Generate candidates"}
          </button>
        ) : null}
      </div>
      {message ? <div className="notice" role="status">{message}</div> : null}
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {loading ? <div className="loading-state">Loading candidate review queue…</div> : data?.candidates.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Transaction</th><th>Suggested order</th><th>Signal strength</th><th>Why suggested</th><th>Decision</th></tr></thead>
            <tbody>{data.candidates.map((candidate) => (
              <tr key={candidate.id}>
                <td>
                  <strong>{candidate.transaction.partner.name}</strong>
                  <span className="table-secondary">{candidate.transaction.kind} · {formatDate(candidate.transaction.transactionDate)}</span>
                  <span className="table-secondary">Net {formatMoney(candidate.transaction.netAmount, candidate.transaction.currency)} · {candidate.transaction.importRow.batch.fileName} row {candidate.transaction.importRow.rowNumber}</span>
                  {candidate.transaction.externalReference ? <span className="table-secondary">Reference: {candidate.transaction.externalReference}</span> : null}
                </td>
                <td>
                  <strong>{candidate.candidateOrder.externalId}</strong>
                  <span className="table-secondary">{candidate.candidateOrder.channelPartner.name} · {formatDate(candidate.candidateOrder.orderDate)}</span>
                  <span className="table-secondary">Order value {formatMoney(candidate.candidateOrder.orderValue, candidate.candidateOrder.currency)}</span>
                  {candidate.transaction.alternatives > 1 ? <StatusPill status={`${candidate.transaction.alternatives} competing candidates`} /> : null}
                </td>
                <td>{candidate.confidence ? `${(Number(candidate.confidence) * 100).toFixed(0)}%` : "—"}</td>
                <td>{candidate.reason}</td>
                <td>
                  {!canManage ? <span className="muted-note">Read-only oversight</span> : confirming === candidate.id ? (
                    <div className="candidate-confirm">
                      <p role="alert">This will link the transaction to {candidate.candidateOrder.externalId}. Existing reconciliation history stays unchanged and the exception remains open.</p>
                      <button className="button button-primary button-small" type="button" onClick={() => decide(candidate, "accept")} disabled={working}>Confirm link</button>
                      <button className="button button-quiet button-small" type="button" onClick={() => setConfirming("")} disabled={working}>Cancel</button>
                    </div>
                  ) : (
                    <div className="candidate-actions">
                      <button className="button button-secondary button-small" type="button" onClick={() => decide(candidate, "accept")} disabled={working}>Review accept</button>
                      <button className="button button-quiet button-small" type="button" onClick={() => decide(candidate, "reject")} disabled={working}>Reject</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <h2>{data?.total ? "No candidates on this page" : "No pending match candidates"}</h2>
          <p>Generate candidates to review unmatched transactions, or continue investigating them in Exceptions.</p>
        </div>
      )}
      {data && data.pageCount > 1 ? (
        <div className="pagination">
          <button className="button button-secondary" type="button" onClick={() => void load(page - 1)} disabled={page <= 1 || loading}>Previous</button>
          <span>Page {page} of {data.pageCount}</span>
          <button className="button button-secondary" type="button" onClick={() => void load(page + 1)} disabled={page >= data.pageCount || loading}>Next</button>
        </div>
      ) : null}
    </section>
  );
}
