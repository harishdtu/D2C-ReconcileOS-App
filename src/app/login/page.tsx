import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginForm from "./login-form";
import { getAuthenticatedUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getAuthenticatedUser()) redirect("/dashboard");
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">R</span>
          <span>
            <strong>reconcile<span>os</span></strong>
            <small>FINANCE OPERATIONS</small>
          </span>
        </div>
        <div className="login-intro">
          <span className="eyebrow">COMPANY A · FINANCE WORKSPACE</span>
          <h1>Close the books<br />with confidence.</h1>
          <p>Review partner settlements, COD remittances and freight charges with evidence behind every number.</p>
        </div>
        <LoginForm />
        <p className="login-privacy">Private workspace · Access is managed by your administrator</p>
      </section>
      <aside className="login-aside" aria-label="Reconciliation workspace">
        <div className="login-aside-orbit orbit-one" />
        <div className="login-aside-orbit orbit-two" />
        <div className="login-aside-copy">
          <span className="eyebrow">FINANCIAL CLARITY, ROW BY ROW</span>
          <p>One place to see what arrived, what is still owed, and the evidence to act.</p>
          <div className="login-aside-line"><span /> BUILT FOR FINANCE TEAMS</div>
        </div>
      </aside>
    </main>
  );
}
