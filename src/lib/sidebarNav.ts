import {
  Activity,
  Bell,
  CalendarClock,
  ChartCandlestick,
  CircleHelp,
  Coins,
  Gauge,
  Newspaper,
  Settings,
  type LucideIcon
} from "lucide-react";

export type SidebarNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

/** Visible sidebar order (do not sort — render in array order). */
export const sidebarNavItems: SidebarNavItem[] = [
  { href: "/dashboard", label: "داشبورد", icon: Gauge },
  { href: "/tether-market", label: "بازار تتر ایران", icon: ChartCandlestick },
  { href: "/gold", label: "بازار طلا", icon: Coins },
  { href: "/exchange-monitor", label: "مانیتور صرافی‌ها", icon: Activity },
  { href: "/impact-news", label: "خبرهای اثرگذار", icon: Newspaper },
  { href: "/forex", label: "اخبار فارکس", icon: CalendarClock },
  { href: "/alerts", label: "هشدارها", icon: Bell },
  { href: "/settings", label: "تنظیمات", icon: Settings, adminOnly: true },
  { href: "/help", label: "راهنما", icon: CircleHelp }
];