/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Internal workspace packages ship TypeScript source.
  transpilePackages: ["@mp/format", "@mp/contracts", "@mp/ui"],
};

export default nextConfig;
