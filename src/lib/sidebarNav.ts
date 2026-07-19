import {
  CalendarClock,
  ChartCandlestick,
  Coins,
  Gauge,
  Newspaper,
  Percent,
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
  { href: "/dashboard", label: "مانیتورینگ", icon: Gauge },
  { href: "/tether-market", label: "بازار تتر ایران", icon: ChartCandlestick },
  { href: "/gold", label: "بازار طلا", icon: Coins },
  { href: "/bubble", label: "حباب", icon: Percent },
  { href: "/impact-news", label: "خبرهای اثرگذار", icon: Newspaper },
  { href: "/forex", label: "اخبار فارکس", icon: CalendarClock }
];
