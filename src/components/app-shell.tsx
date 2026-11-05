"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { AuthenticatedUser } from "@/lib/auth";

const navigation = [
  { href: "/dashboard", label: "Overview", code: "01" },
  { href: "/imports", label: "Imports", code: "02" },
  { href: "/orders", label: "Orders", code: "03" },
  { href: "/reconciliation", label: "Reconciliation", code: "04" },
  { href: "/claims", label: "Claims", code: "05" },
  { href: "/exceptions", label: "Exceptions", code: "06" },
  { href: "/match-review", label: "Match review", code: "07" },
  { href: "/audit", label: "Audit trail", code: "08" },
];

export default function AppShell({
  user,
  children,
}: {
  user: AuthenticatedUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not end the session. Try again.");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Could not end the session.");
      setLoggingOut(false);
    }
  }

  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="Main navigation">
        <Link className="brand" href="/dashboard" aria-label="ReconcileOS overview">
          <span className="brand-mark" aria-hidden="true">R</span>
          <span>
            <strong>reconcile<span>os</span></strong>
            <small>FINANCE OPERATIONS</small>
          </span>
        </Link>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list">
          {navigation.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                className={`nav-link${active ? " active" : ""}`}
                href={item.href}
                key={item.href}
                aria-current={active ? "page" : undefined}
              >
                <span className="nav-code">{item.code}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="workspace-chip"><span className="live-dot" /> Company A · India</div>
          <p>Financial evidence stays private to your workspace.</p>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          <div className="topbar-context">
            <span className="breadcrumb">RECONCILEOS</span>
            <span className="breadcrumb-divider">/</span>
            <span className="breadcrumb-current">{navigation.find((item) =>
              pathname === item.href || pathname.startsWith(`${item.href}/`),
            )?.label ?? "Workspace"}</span>
          </div>
          <div className="account">
            <span className="account-role">{user.role === "CO_FOUNDER" ? "CO-FOUNDER" : "FINANCE"}</span>
            <span className="account-avatar" aria-hidden="true">
              {user.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="account-email">{user.email}</span>
            <button className="button button-quiet button-small" onClick={logout} disabled={loggingOut}>
              {loggingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </header>
        {logoutError ? <p className="shell-error" role="alert">{logoutError}</p> : null}
        <main className="page-main">{children}</main>
        <footer className="page-footer">
          <span>RECONCILEOS</span>
          <span>Financial records are shown in their source currency.</span>
        </footer>
      </div>
    </div>
  );
}
