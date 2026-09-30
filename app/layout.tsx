import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
const inter = localFont({
  src: [
    { path: "../public/fonts/inter-regular.ttf", weight: "400", style: "normal" },
    { path: "../public/fonts/inter-medium.ttf", weight: "500", style: "normal" },
    { path: "../public/fonts/inter-semibold.ttf", weight: "600", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});
const mono = localFont({
  src: "../public/fonts/jetbrains-mono-regular.ttf",
  variable: "--font-jetbrains",
  display: "swap",
});
export const metadata: Metadata = {
  title: "EduFlow — 지식을 장면으로",
  description: "교육 원고부터 장면, 나레이션, 자막까지. 교육의 흐름을 설계하는 스토리보드 스튜디오.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
