import PageHeading from "@/components/page-heading";
import OrdersTable from "./table";

export default function OrdersPage() {
  return (
    <>
      <PageHeading
        eyebrow="ORDER LEDGER"
        title="Orders"
        description="Search channel orders and compare each order's most recent reconciliation outcome."
      />
      <OrdersTable />
    </>
  );
}
