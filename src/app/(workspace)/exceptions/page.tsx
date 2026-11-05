import PageHeading from "@/components/page-heading";
import ExceptionsWorkbench from "./workbench";

export default function ExceptionsPage() {
  return (
    <>
      <PageHeading
        eyebrow="CASE MANAGEMENT"
        title="Exceptions"
        description="Investigate unmatched records and partner discrepancies, then record an authorized, auditable outcome."
      />
      <ExceptionsWorkbench />
    </>
  );
}
