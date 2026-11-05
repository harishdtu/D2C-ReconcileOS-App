import Link from "next/link";
import PageHeading from "@/components/page-heading";
import StatusPill from "@/components/status-pill";
import { formatDate, formatMoney } from "@/lib/format";
import { getDashboardOverview } from "@/lib/dashboard/service";

function AmountList({
  rows,
}: {
  rows: Array<{ currency: string; amount: string }>;
}) {
  if (!rows.length) return <strong>—</strong>;
  return (
    <span className="metric-amount-list">
      {rows.map((row) => (
        <strong key={row.currency}>{formatMoney(row.amount, row.currency)}</strong>
      ))}
    </span>
  );
}

export default async function DashboardPage() {
  const data = await getDashboardOverview();
  const orderValues = data.byCurrency.map((row) => ({
    currency: row.currency,
    amount: row.orderValue,
  }));
  const receivedValues = data.byCurrency
    .filter((row) => row.paymentsReceived !== "0.00")
    .map((row) => ({ currency: row.currency, amount: row.paymentsReceived }));
  const riskValues = data.byCurrency
    .filter((row) => row.openExceptionAmount !== "0.00")
    .map((row) => ({ currency: row.currency, amount: row.openExceptionAmount }));
  const runTotal = data.recentRuns.find((run) => run.id === data.latestCompletedRunId)?.resultCount ?? 0;

  return (
    <>
      <PageHeading
        eyebrow="FINANCE OVERVIEW"
        title="Financial overview"
        description="A live view of orders, partner remittances and the cases that need attention."
        actions={<Link className="button button-primary" href="/imports">Start an import <span aria-hidden="true">↗</span></Link>}
      />
      <section className="metric-grid" aria-label="Financial overview">
        <article className="metric-card">
          <div className="metric-top"><span>Total orders</span><span className="metric-mark" aria-hidden="true">↗</span></div>
          <div className="metric-value">{data.orderCount.toLocaleString("en-IN")}</div>
          <div className="metric-foot">Persisted orders across all channels</div>
        </article>
        <article className="metric-card">
          <div className="metric-top"><span>Order value</span><span className="metric-mark" aria-hidden="true">₹</span></div>
          <div className="metric-value metric-value-money"><AmountList rows={orderValues} /></div>
          <div className="metric-foot">Gross order value, grouped by source currency</div>
        </article>
        <article className="metric-card">
          <div className="metric-top"><span>Payments received</span><span className="metric-mark" aria-hidden="true">↓</span></div>
          <div className="metric-value metric-value-money"><AmountList rows={receivedValues} /></div>
          <div className="metric-foot">Settlement and COD net transactions recorded</div>
        </article>
        <article className="metric-card">
          <div className="metric-top"><span>Open exceptions</span><span className="metric-mark" aria-hidden="true">!</span></div>
          <div className="metric-value">{data.openExceptionCount.toLocaleString("en-IN")}</div>
          <div className="metric-foot">Open or in-review cases · <AmountList rows={riskValues} /> at risk</div>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="currency-title">
          <div className="panel-heading">
            <div><h2 id="currency-title">Reconciliation health</h2><p>Differences are from the latest completed run.</p></div>
            <Link className="text-link" href="/reconciliation">View results <span aria-hidden="true">→</span></Link>
          </div>
          {data.byCurrency.length ? (
            <div className="currency-stack panel-content">
              {data.byCurrency.map((row) => (
                <div className="currency-section" key={row.currency}>
                  <div className="currency-heading"><span>{row.currency}</span><span>{row.orderCount.toLocaleString("en-IN")} orders</span></div>
                  <div className="currency-line"><span>Latest run exposure · {row.latestRunDiscrepancyCount} supported cases</span><strong>{formatMoney(row.latestRunDiscrepancyAmount, row.currency)}</strong></div>
                  <div className="currency-line"><span>Open exception exposure</span><strong>{formatMoney(row.openExceptionAmount, row.currency)}</strong></div>
                  {row.codTotalCount ? <div className="currency-line"><span>COD settled · {row.codSettledCount} of {row.codTotalCount} orders</span><strong>{formatMoney(row.codReceivedAmount, row.currency)}</strong></div> : null}
                </div>
              ))}
              <p className="muted-note">Differences include short-paid, past-due and freight-overcharge results only; tax withholding is not included as recoverable leakage.</p>
            </div>
          ) : (
            <div className="empty-state"><strong>No operational data yet</strong><p>Import an order file to begin tracking partner settlements.</p></div>
          )}
        </section>

        <section className="panel" aria-labelledby="runs-title">
          <div className="panel-heading">
            <div><h2 id="runs-title">Recent activity</h2><p>{runTotal.toLocaleString("en-IN")} results in the latest completed run</p></div>
            <span className="metric-mark" aria-hidden="true">↻</span>
          </div>
          {data.recentRuns.length ? (
            <div className="panel-content run-list">
              {data.recentRuns.map((run) => (
                <div className="run-row" key={run.id}>
                  <div>
                    <div className="run-id">{run.id.slice(0, 8).toUpperCase()}</div>
                    <div className="run-meta">{formatDate(run.startedAt)} · {run.resultCount.toLocaleString("en-IN")} results</div>
                  </div>
                  <StatusPill status={run.status} />
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state"><strong>No reconciliation runs</strong><p>Complete an import, then run reconciliation to see results here.</p></div>
          )}
        </section>
      </div>

      <section className="panel section-spacer" aria-labelledby="risk-title">
        <div className="panel-heading">
          <div><h2 id="risk-title">Money at risk by partner</h2><p>Open exception exposure is aged from exception creation date.</p></div>
          <Link className="text-link" href="/exceptions">Review exceptions <span aria-hidden="true">→</span></Link>
        </div>
        {data.riskByPartner.length ? (
          <div className="risk-list">
            <div className="risk-row risk-header"><span>PARTNER</span><span className="risk-amount">0–7 DAYS</span><span className="risk-amount">8–30 DAYS</span><span className="risk-amount">31+ DAYS</span></div>
            {data.riskByPartner.map((item) => (
              item.currencies.map((currency) => (
                <div className="risk-row" key={`${item.partner.code}-${currency.currency}`}>
                  <span className="risk-partner">{item.partner.name}<small>{item.partner.code} · {currency.currency}</small></span>
                  <span className="risk-amount">{formatMoney(currency.age0To7, currency.currency)}</span>
                  <span className="risk-amount">{formatMoney(currency.age8To30, currency.currency)}</span>
                  <span className="risk-amount">{formatMoney(currency.age31Plus, currency.currency)}</span>
                </div>
              ))
            ))}
          </div>
        ) : (
          <div className="empty-state"><strong>No open exposure</strong><p>Open short, late and overcharge cases will appear here, grouped by partner and currency.</p></div>
        )}
      </section>
    </>
  );
}
