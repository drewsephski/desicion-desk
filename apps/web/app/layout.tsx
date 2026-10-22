import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Decision Desk",
  description:
    "Point Decision Desk at your website or GitHub repo. Four models recommend a decision tailored to it, and a judge returns the call, the main risk, and the next 24 hours.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={`${GeistSans.variable} ${GeistMono.variable}`} lang="en">
      <head>
        <link href="https://vercel.com/geist/vercel-brand.css" precedence="vbg" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
