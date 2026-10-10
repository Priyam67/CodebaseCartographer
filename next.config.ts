import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // web-tree-sitter loads .wasm files from disk at runtime, so it must stay
  // external to the server bundle instead of being bundled by webpack/turbopack.
  serverExternalPackages: ["web-tree-sitter", "tree-sitter-wasms"],

  // Only matters for deployments that trace files (e.g. serverless); harmless locally.
  outputFileTracingIncludes: {
    "/api/analyze": [
      "./node_modules/web-tree-sitter/tree-sitter.wasm",
      "./node_modules/tree-sitter-wasms/out/*.wasm",
    ],
  },
};

export default nextConfig;
