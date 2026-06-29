import { Shell } from "@/components/Shell";

export default function DeskLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Shell>{children}</Shell>;
}
