import type { Metadata } from 'next';
import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google';
import '../styles/globals.css';

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
  display: 'swap',
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SONAR — Multi-Chain Whale Tracker & Alpha Radar',
  description:
    'Real-time whale tracking and AI-powered signal scoring across Solana, Ethereum, Arbitrum, and Base. Get consensus alerts when smart money moves together.',
  openGraph: {
    title: 'SONAR — Multi-Chain Whale Tracker',
    description:
      'Smart money consensus alerts across Solana, Ethereum, Arbitrum, and Base.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#0a0a0f] text-[#e8e8ef]">
        {children}
      </body>
    </html>
  );
}
