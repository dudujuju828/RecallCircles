/** @type {import('next').NextConfig} */
const nextConfig = {
  // BYOK app: lint warnings should never block a Vercel build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
