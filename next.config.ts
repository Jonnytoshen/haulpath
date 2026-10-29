import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: process.env.HAULPATH_BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  serverExternalPackages: ['better-sqlite3'],
  async rewrites() {
    return [{ source: '/_AMapService/:path*', destination: '/api/amap/:path*' }];
  },
};

export default nextConfig;
