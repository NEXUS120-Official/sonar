import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Fix: multiple lockfiles warning — set repo root explicitly
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Silence outputFileTracingRoot warning for the same reason
  outputFileTracingRoot: path.resolve(__dirname),
};

export default nextConfig;
