import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Force unique build output to bust Vercel cache
  generateBuildId: async () => `wp_${Date.now()}`,
};

export default nextConfig;
