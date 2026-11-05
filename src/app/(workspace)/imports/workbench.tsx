"use client";

import { ImportKind } from "@prisma/client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import StatusPill from "@/components/status-pill";
import { formatDate, humanize } from "@/lib/format";
import { fieldDefinitions, suggestColumns } from "@/lib/imports/mapping";

type Partner = { code: string; name: string; kind: string };
type Batch = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number | null;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  createdAt: string;
  completedAt: string | null;
  source: { id: string; kind: ImportKind; sourceKey: string; partner: Partner };
  mappingVersion: { version: number } | null;
};
type Source = {
  id: string;
  kind: ImportKind;
  sourceKey: string;
  activeMappingVersionId: string | null;
  partner: Partner;
  mappingVersions: Array<{
    id: string;
    version: number;
    rollbackOfId: string | null;
    approvedAt: string;
  }>;
};
type SourceData = { partners: Partner[]; sources: Source[] };
type UploadPreview = {
  id: string;
  status: string;
  headers?: string[];
  previewRows?: Array<Record<string, string>>;
  totalRows: number | null;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  duplicateUpload: boolean;
};
type MappedRow = {
  sourceRowNumber: number;
  normalized: Record<string, unknown>;
  errors: string[];
};
type MappingPreview = { mappingPreviewHash: string; previewRows: MappedRow[] };
type MappingSuggestion = {
  id?: string;
  mode: "AI" | "DETERMINISTIC";
  mapping: Record<string, string>;
  columns: Array<{
    sourceColumn: string;
    status: "mapped" | "ambiguous" | "unsupported";
    destinationField?: string;
    confidence?: number;
    explanation: string;
  }>;
  confidence?: number | null;
  explanation: string;
  unavailableReason: string | null;
};

const coreKinds = [
  ImportKind.ORDER,
  ImportKind.SETTLEMENT,
  ImportKind.COD_REMITTANCE,
  ImportKind.FREIGHT_INVOICE,
];

function initialSourceKey(partnerCode: string, kind: ImportKind) {
  return `${partnerCode}-${kind.toLowerCase().replaceAll("_", "-")}`;
}

export default function ImportsWorkbench({ canManage }: { canManage: boolean }) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [partnerCode, setPartnerCode] = useState("");
  const [kind, setKind] = useState<ImportKind>(ImportKind.ORDER);
  const [sourceKey, setSourceKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [upload, setUpload] = useState<UploadPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingSuggestion, setMappingSuggestion] = useState<MappingSuggestion | null>(null);
  const [mappingSuggestionId, setMappingSuggestionId] = useState("");
  const [mappingPreview, setMappingPreview] = useState<MappingPreview | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const loadSources = useCallback(async () => {
    const response = await fetch("/api/import-sources", { cache: "no-store" });
    const body = await response.json() as SourceData & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load import sources.");
    setPartners(body.partners);
    setSources(body.sources);
    if (!partnerCode && body.partners.length) {
      const defaultPartner = body.partners.find((partner) => partner.kind === "WEBSITE") ?? body.partners[0];
      setPartnerCode(defaultPartner.code);
      setSourceKey(initialSourceKey(defaultPartner.code, kind));
    }
  }, [kind, partnerCode]);

  const loadBatches = useCallback(async (nextPage = page) => {
    const params = new URLSearchParams({ page: String(nextPage), limit: "25" });
    if (statusFilter) params.set("status", statusFilter);
    if (search.trim()) params.set("search", search.trim());
    const response = await fetch(`/api/imports?${params}`, { cache: "no-store" });
    const body = await response.json() as { batches?: Batch[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load import history.");
    setBatches(body.batches ?? []);
  }, [page, search, statusFilter]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadSources(), loadBatches()]);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load imports.");
    } finally {
      setLoading(false);
    }
  }, [loadBatches, loadSources]);

  // Start authenticated source and batch reads on mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);

  const fields = useMemo(() => fieldDefinitions[kind], [kind]);
  function choosePartner(code: string) {
    setPartnerCode(code);
    setSourceKey(initialSourceKey(code, kind));
  }
  function chooseKind(value: ImportKind) {
    setKind(value);
    setSourceKey(initialSourceKey(partnerCode, value));
    setFile(null);
    setFileInputKey((current) => current + 1);
    setUpload(null);
    setMappingSuggestion(null);
    setMappingSuggestionId("");
    setMappingPreview(null);
  }
  function onUploadFile(value: File | null) {
    setFile(value);
    setUpload(null);
    setMappingSuggestion(null);
    setMappingSuggestionId("");
    setMappingPreview(null);
    setMessage("");
    setError("");
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("partnerCode", partnerCode);
      form.set("sourceKey", sourceKey.trim());
      form.set("kind", kind);
      const response = await fetch("/api/imports", { method: "POST", body: form });
      const body = await response.json() as UploadPreview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Upload failed.");
      setUpload(body);
      setFile(null);
      setFileInputKey((current) => current + 1);
      setMapping(body.headers ? suggestColumns(body.headers, kind).mapping : {});
      setMappingSuggestion(null);
      setMappingSuggestionId("");
      setMappingPreview(null);
      if (body.duplicateUpload) {
        setMessage("This file was already uploaded to this source. Existing batch counts are shown below.");
      }
      await Promise.all([loadSources(), loadBatches(1)]);
      setPage(1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed.");
    } finally {
      setWorking(false);
    }
  }

  async function requestMappingSuggestion() {
    if (!upload) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${upload.id}/suggest-mapping`, { method: "POST" });
      const body = await response.json() as MappingSuggestion & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not request mapping suggestions.");
      setMappingSuggestion(body);
      setMappingSuggestionId(body.id ?? "");
      setMappingPreview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not request mapping suggestions.");
    } finally {
      setWorking(false);
    }
  }

  function applyMappingSuggestion() {
    if (!mappingSuggestion) return;
    setMapping(mappingSuggestion.mapping);
    setMappingSuggestionId(mappingSuggestion.id ?? "");
    setMappingPreview(null);
  }

  async function previewMap() {
    if (!upload) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${upload.id}/mapping-preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      const body = await response.json() as MappingPreview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Mapping preview failed.");
      setMappingPreview(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Mapping preview failed.");
    } finally {
      setWorking(false);
    }
  }

  async function approveMap() {
    if (!upload || !mappingPreview) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${upload.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mapping,
          mappingPreviewHash: mappingPreview.mappingPreviewHash,
          ...(mappingSuggestionId ? { mappingSuggestionId } : {}),
        }),
      });
      const body = await response.json() as {
        status: string;
        acceptedRows: number;
        rejectedRows: number;
        duplicateRows: number;
        idempotentReplay: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Import processing failed.");
      setMessage(
        `Import ${body.idempotentReplay ? "already completed" : "completed"}: ${body.acceptedRows} accepted, ${body.rejectedRows} rejected, ${body.duplicateRows} duplicates.`,
      );
      setUpload(null);
      setMappingPreview(null);
      setFile(null);
      await Promise.all([loadSources(), loadBatches(1)]);
      setPage(1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import processing failed.");
      await loadBatches(1).catch(() => undefined);
    } finally {
      setWorking(false);
    }
  }

  async function rollback(source: Source, version: number) {
    if (!window.confirm(`Create a new active mapping version based on version ${version}?`)) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/import-sources/${source.id}/mappings/${version}/rollback`, {
        method: "POST",
      });
      const body = await response.json() as { version?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Mapping rollback failed.");
      setMessage(`Mapping rolled back into new version ${body.version}.`);
      await loadSources();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Mapping rollback failed.");
    } finally {
      setWorking(false);
    }
  }

  async function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    await loadBatches(1).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Could not filter imports."),
    );
  }

  return (
    <div className="workbench-grid">
      {canManage ? (
        <section className="panel import-panel" aria-labelledby="upload-title">
          <div className="panel-heading">
            <div><h2 id="upload-title">New source file</h2><p>CSV or XLSX · maximum 50 MB · preview before processing</p></div>
            <span className="metric-mark" aria-hidden="true">＋</span>
          </div>
          <form className="panel-content import-form" onSubmit={submitUpload}>
            <div className="form-grid">
              <div className="field">
                <label className="field-label" htmlFor="partner">Channel or carrier</label>
                <select id="partner" value={partnerCode} onChange={(event) => choosePartner(event.target.value)} required>
                  {partners.map((partner) => <option key={partner.code} value={partner.code}>{partner.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="kind">File type</label>
                <select id="kind" value={kind} onChange={(event) => chooseKind(event.target.value as ImportKind)}>
                  {coreKinds.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </select>
              </div>
              <div className="field form-span">
                <label className="field-label" htmlFor="sourceKey">Source identifier</label>
                <input id="sourceKey" value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} maxLength={120} required />
              </div>
            </div>
            <label className="file-drop">
              <span><strong>Choose an operational file</strong><small>Original file is retained privately as import evidence.</small></span>
              <input
                key={fileInputKey}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => onUploadFile(event.target.files?.[0] ?? null)}
                required
              />
            </label>
            <div className="upload-action">
              {file ? <span className="muted-note">{file.name} · {(file.size / 1024).toFixed(0)} KB</span> : <span className="muted-note">Choose a file to continue.</span>}
              <button className="button button-primary" disabled={working || !file}>{working ? "Uploading…" : "Upload and preview"}</button>
            </div>
          </form>

          {upload ? (
            <div className="mapping-workflow">
              {upload.duplicateUpload ? (
                <div className="notice">Duplicate file detected · batch {upload.id.slice(0, 8)} · {upload.totalRows ?? 0} rows · {humanize(upload.status)}</div>
              ) : (
                <>
                  <div className="mapping-heading">
                    <div><h3>Map source columns</h3><p>{upload.totalRows?.toLocaleString("en-IN")} total rows · showing a masked sample</p></div>
                    <span className="status-pill status-info">20-row review</span>
                  </div>
                  <p className="muted-note mapping-guidance">Choose the source column for each required field. Exact header matches are preselected for convenience; review all selections before approving.</p>
                  <div className="upload-action mapping-action">
                    <span className="muted-note">AI sees column names and allowed fields only, never source rows.</span>
                    <button className="button button-secondary" type="button" onClick={requestMappingSuggestion} disabled={working}>
                      {working ? "Requesting…" : "Request AI suggestions"}
                    </button>
                  </div>
                  {mappingSuggestion ? (
                    <div className="mapping-suggestion" aria-live="polite">
                      <div className="mapping-heading">
                        <div>
                          <h3>{mappingSuggestion.mode === "AI" ? "AI mapping suggestions" : "Deterministic mapping fallback"}</h3>
                          <p>{mappingSuggestion.explanation}</p>
                        </div>
                        <span className={`status-pill ${mappingSuggestion.mode === "AI" ? "status-info" : "status-warning"}`}>
                          {mappingSuggestion.mode === "AI" ? "Human approval required" : "Not AI-generated"}
                        </span>
                      </div>
                      {mappingSuggestion.mode === "AI" && typeof mappingSuggestion.confidence === "number" ? (
                        <p className="muted-note">Mean model-reported confidence: {(mappingSuggestion.confidence * 100).toFixed(0)}%. This is not a calibrated probability.</p>
                      ) : null}
                      <div className="table-wrap">
                        <table className="data-table">
                          <thead><tr><th>Source column</th><th>Suggestion</th><th>Confidence</th><th>Reason / uncertainty</th></tr></thead>
                          <tbody>{mappingSuggestion.columns.map((column) => (
                            <tr key={column.sourceColumn}>
                              <td>{column.sourceColumn}</td>
                              <td>{column.status === "mapped" ? humanize(column.destinationField ?? "") : humanize(column.status)}</td>
                              <td>{mappingSuggestion.mode === "AI" && typeof column.confidence === "number" ? `${(column.confidence * 100).toFixed(0)}%` : "—"}</td>
                              <td>{column.explanation}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                      <div className="upload-action mapping-action">
                        <span className="muted-note">Suggestions do not approve or process an import.</span>
                        <button className="button button-secondary" type="button" onClick={applyMappingSuggestion}>
                          {mappingSuggestion.mode === "AI" ? "Apply for review" : "Use deterministic suggestions"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="mapping-grid">
                    {fields.map((field) => (
                      <div className="mapping-row" key={field.key}>
                        <label htmlFor={`map-${field.key}`}>{field.label}{field.required ? " *" : ""}</label>
                        <select
                          className="mapping-select"
                          id={`map-${field.key}`}
                          value={mapping[field.key] ?? ""}
                          onChange={(event) => {
                            setMapping((current) => ({ ...current, [field.key]: event.target.value }));
                            setMappingPreview(null);
                          }}
                        >
                          <option value="">Not mapped</option>
                          {(upload.headers ?? []).map((header) => <option key={header} value={header}>{header}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                  <div className="upload-action mapping-action">
                    <span className="muted-note">Required fields are marked with an asterisk.</span>
                    <button className="button button-secondary" type="button" onClick={previewMap} disabled={working}>
                      {working ? "Checking…" : "Preview mapped rows"}
                    </button>
                  </div>
                  {mappingPreview ? (
                    <>
                      <div className="mapping-heading">
                        <div><h3>20-row mapping preview</h3><p>Review normalized values and validation findings before processing.</p></div>
                      </div>
                      <div className="preview-scroll table-wrap">
                        <table className="data-table">
                          <thead><tr><th>Row</th>{fields.filter((field) => mapping[field.key]).map((field) => <th key={field.key}>{field.label}</th>)}<th>Validation</th></tr></thead>
                          <tbody>
                            {mappingPreview.previewRows.map((row) => (
                              <tr key={row.sourceRowNumber}>
                                <td>{row.sourceRowNumber}</td>
                                {fields.filter((field) => mapping[field.key]).map((field) => (
                                  <td key={field.key}>{String(row.normalized[field.key] ?? "—")}</td>
                                ))}
                                <td>{row.errors.length ? <span className="status-pill status-danger">{row.errors.join("; ")}</span> : <span className="status-pill status-success">Valid</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="upload-action mapping-action">
                        <span className="muted-note">Approval saves this mapping as a source version and processes all rows.</span>
                        <button className="button button-primary" type="button" onClick={approveMap} disabled={working}>{working ? "Processing…" : "Approve mapping and import"}</button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </section>
      ) : (
        <section className="panel">
          <div className="panel-heading"><div><h2>Imports</h2><p>Read-only access for finance oversight.</p></div></div>
          <div className="panel-content"><p className="muted-note">Your role can review import history, but cannot upload or approve files.</p></div>
        </section>
      )}

      {message ? <div className="notice" role="status">{message}</div> : null}
      {error ? <div className="alert" role="alert">{error}</div> : null}

      <section className="panel" aria-labelledby="mapping-history-title">
        <div className="panel-heading"><div><h2 id="mapping-history-title">Saved source mappings</h2><p>Approved mappings are versioned; rollback creates a new version.</p></div></div>
        {loading ? <div className="loading-state">Loading source mappings…</div> : sources.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Partner / source</th><th>Type</th><th>Active version</th><th>History</th></tr></thead>
              <tbody>
                {sources.map((source) => {
                  const active = source.mappingVersions.find((version) => version.id === source.activeMappingVersionId);
                  return (
                    <tr key={source.id}>
                      <td><span className="table-primary">{source.partner.name}</span><span className="table-secondary">{source.sourceKey}</span></td>
                      <td>{humanize(source.kind)}</td>
                      <td>{active ? `v${active.version}` : "No approved mapping"}</td>
                      <td>
                        {canManage ? (
                          <div className="history-buttons">{source.mappingVersions.filter((version) => version.id !== source.activeMappingVersionId).slice(0, 3).map((version) => (
                            <button className="button button-secondary button-small" disabled={working} key={version.id} onClick={() => void rollback(source, version.version)}>Restore v{version.version}</button>
                          ))}</div>
                        ) : <span className="muted-note">{source.mappingVersions.length} versions</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-state"><strong>No saved mappings</strong><p>A source mapping is saved when an import is approved.</p></div>}
      </section>

      <section className="panel section-spacer" aria-labelledby="history-title">
        <div className="panel-heading"><div><h2 id="history-title">Import history</h2><p>Every uploaded batch remains linked to its source file and row-level outcome.</p></div></div>
        <div className="toolbar">
          <form className="filter-form" onSubmit={filter}>
            <div className="field grow"><label className="field-label" htmlFor="import-search">Search source or file</label><input id="import-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Partner, file name, source key" /></div>
            <div className="field"><label className="field-label" htmlFor="import-status">Status</label><select id="import-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{["PREVIEWED", "PROCESSING", "COMPLETED", "FAILED"].map((status) => <option key={status} value={status}>{humanize(status)}</option>)}</select></div>
            <button className="button button-secondary" type="submit">Apply filters</button>
          </form>
        </div>
        {loading ? <div className="loading-state">Loading import history…</div> : batches.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>File / source</th><th>Partner</th><th>Rows</th><th>Outcome</th><th>Mapping</th><th>Status</th><th>Uploaded</th></tr></thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td><span className="table-primary">{batch.fileName}</span><span className="table-secondary">{humanize(batch.source.kind)} · {batch.source.sourceKey}</span></td>
                    <td>{batch.source.partner.name}</td>
                    <td>{batch.totalRows?.toLocaleString("en-IN") ?? "—"}</td>
                    <td>{batch.acceptedRows.toLocaleString("en-IN")} accepted<span className="table-secondary">{batch.rejectedRows} rejected · {batch.duplicateRows} duplicates</span></td>
                    <td>{batch.mappingVersion ? `v${batch.mappingVersion.version}` : "—"}</td>
                    <td><StatusPill status={batch.status} /></td>
                    <td>{formatDate(batch.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-state"><strong>No imports found</strong><p>Upload an order, settlement, COD-remittance or freight-invoice file to get started.</p></div>}
        <div className="table-footer">
          <span>Page {page} · {batches.length} batches shown</span>
          <div className="pagination">
            <button className="button button-secondary button-small" disabled={page <= 1 || loading} onClick={() => { const next = page - 1; setPage(next); void loadBatches(next); }}>Previous</button>
            <span className="pagination-label">Page {page}</span>
            <button className="button button-secondary button-small" disabled={batches.length < 25 || loading} onClick={() => { const next = page + 1; setPage(next); void loadBatches(next); }}>Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
