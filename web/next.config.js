/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Type errors are fixed - strict build enabled
  // ESLint is not configured for this project (would add in production)
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
