import PageHeading from "@/components/page-heading";
import ClaimsWorkbench from "./workbench";

export default function ClaimsPage() {
  return (
    <>
      <PageHeading
        eyebrow="RECOVERY WORKLIST"
        title="Claims"
        description="Review supported short-payment, late-remittance and freight-overcharge cases with source and calculation evidence."
      />
      <ClaimsWorkbench />
    </>
  );
}
