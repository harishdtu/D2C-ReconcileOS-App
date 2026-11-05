import PageHeading from "@/components/page-heading";
import { getAuthenticatedUser } from "@/lib/auth";
import MatchReviewWorkbench from "./workbench";

export default async function MatchReviewPage() {
  const user = await getAuthenticatedUser();
  return (
    <>
      <PageHeading
        eyebrow="HUMAN REVIEW"
        title="Missing-order candidates"
        description="Review explainable candidate signals. No suggestion links or clears a financial case without your confirmation."
      />
      <MatchReviewWorkbench canManage={user?.role === "FINANCE_EXECUTIVE"} />
    </>
  );
}
