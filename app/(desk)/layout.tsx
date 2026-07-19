import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { getSession } from "@/lib/authSession";

export default async function DeskLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Re-check viewer password epoch (middleware only verifies cookie signature).
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return <Shell>{children}</Shell>;
}
