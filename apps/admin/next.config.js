/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@prisma/client', 'prisma', '@napi-rs/canvas'],
  images: {
    remotePatterns: [],
  },
};

module.exports = nextConfig;
