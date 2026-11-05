import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";

export default async function HomePage() {
  const user = await getAuthenticatedUser();
  redirect(user ? "/dashboard" : "/login");
}
