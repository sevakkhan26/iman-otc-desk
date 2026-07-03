import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OTC Dealing Desk",
  description: "داشبورد عملیاتی Dealing Desk / OTC"
};

const themeInitScript = `(function(){try{var t=localStorage.getItem('otc-theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
