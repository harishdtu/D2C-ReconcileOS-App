import { redirect } from "next/navigation";
import AppShell from "@/components/app-shell";
import { getAuthenticatedUser } from "@/lib/auth";

export default async function WorkspaceLayout({
  children,
}: LayoutProps<"/">) {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login");

  return <AppShell user={user}>{children}</AppShell>;
}
