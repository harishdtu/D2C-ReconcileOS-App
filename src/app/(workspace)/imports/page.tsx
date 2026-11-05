import PageHeading from "@/components/page-heading";
import { getAuthenticatedUser } from "@/lib/auth";
import ImportsWorkbench from "./workbench";

export default async function ImportsPage() {
  const user = await getAuthenticatedUser();
  return (
    <>
      <PageHeading
        eyebrow="SOURCE DATA"
        title="Imports"
        description="Upload partner files, review the mapped fields, and keep every row linked to its source."
      />
      <ImportsWorkbench canManage={user?.role === "FINANCE_EXECUTIVE"} />
    </>
  );
}
