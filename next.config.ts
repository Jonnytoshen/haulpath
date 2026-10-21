import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  async rewrites() {
    return [{ source: '/_AMapService/:path*', destination: '/api/amap/:path*' }];
  },
};

export default nextConfig;
