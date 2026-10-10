import type { NextConfig } from 'next';
const config: NextConfig = { devIndicators: false, serverExternalPackages: ["pdf-parse", "mammoth"] };
export default config;
