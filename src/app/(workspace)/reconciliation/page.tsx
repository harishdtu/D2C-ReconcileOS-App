import PageHeading from "@/components/page-heading";
import ReconciliationWorkbench from "./workbench";

export default function ReconciliationPage() {
  return (
    <>
      <PageHeading
        eyebrow="DETERMINISTIC MATCHING"
        title="Reconciliation"
        description="Run the same explainable rules against completed source batches, then review outcomes and supporting records."
      />
      <ReconciliationWorkbench />
    </>
  );
}
