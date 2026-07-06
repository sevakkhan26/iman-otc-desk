import { Shell } from "@/components/Desk";

export default function DeskLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Shell>{children}</Shell>;
}
