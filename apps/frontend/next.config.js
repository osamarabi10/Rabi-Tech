/** @type {import('next').NextConfig} */

const backendApiUrl =
  process.env.NEXT_SERVER_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  // Next writes its own AGENTS.md and CLAUDE.md into apps/frontend on dev
  // start. Disabled rather than gitignored: an ignored file still sits on disk
  // where an agent reads it, and a near-duplicate rules file next to the real
  // one at the repository root is the wrong-artifact hazard in its purest form.
  agentRules: false,
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      ],
    },
  ],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
    NEXT_PUBLIC_API_PORT: process.env.NEXT_PUBLIC_API_PORT || '4000',
  },
  rewrites: async () => {
    return {
      beforeFiles: [
        // Proxy backend health checks used by the login screen
        {
          source: '/health',
          destination: `${backendApiUrl}/health`,
        },
        // Proxy /api/* requests to the backend API
        {
          source: '/api/:path*',
          destination: `${backendApiUrl}/api/:path*`,
        },
        // Proxy socket.io upgrade requests
        {
          source: '/socket.io',
          destination: `${backendApiUrl}/socket.io`,
        },
        {
          source: '/socket.io/:path*',
          destination: `${backendApiUrl}/socket.io/:path*`,
        },
      ],
    };
  },
};

module.exports = nextConfig;
