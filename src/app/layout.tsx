import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentCafe — Daum 카페 자율 운영 에이전트",
  description: "Claude가 다음 카페 UI를 직접 조작해 카페 생성·글 작성·모더레이션을 수행합니다",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" data-theme="light">
      <body>{children}</body>
    </html>
  );
}
