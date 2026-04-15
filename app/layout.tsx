import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata() {
  const metaTitle = "File Uploader";
  const metadata: Metadata = {
    title: metaTitle,
    description: "File Uploader",
    authors: [{ name: "" }],
    keywords: ["File Uploader"],
    openGraph: {
      title: metaTitle,
      description: "File Uploader",
      url: "",
      type: "website",
    },
    twitter: {
      title: metaTitle,
      description: "File Uploader",
      site: "",
    },

    other: {
      "app-version": "v0.1.0",
    },
  };

  return metadata;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
