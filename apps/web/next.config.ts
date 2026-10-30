import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
  transpilePackages: ['@haulpath/domain'],
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  output: process.env.HAULPATH_BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  serverExternalPackages: ['better-sqlite3'],
  async rewrites() {
    return [{ source: '/_AMapService/:path*', destination: '/api/amap/:path*' }];
  },
};

export default nextConfig;
