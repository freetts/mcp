// Settings from the environment. Nothing secret lives in the repo.
import { randomBytes } from "node:crypto";

const env = (k: string, d = "") => (process.env[k] ?? d).trim();

export const CONFIG = {
  port: Number(env("PORT", "8788")),
  host: env("HOST", "127.0.0.1"),
  /** Where clients reach us. Metadata and audio links are built from it. */
  publicUrl: env("PUBLIC_URL", "https://mcp.freetts.org").replace(/\/$/, ""),
  /** FastAPI on this machine. */
  apiUrl: env("FASTAPI_URL", "http://127.0.0.1:8042").replace(/\/$/, ""),
  /** Public address of the site (links in replies). */
  siteUrl: "https://freetts.org",
  /** The service's own FreeTTS key, for callers who have no account. */
  serviceApiKey: env("FREETTS_SERVICE_API_KEY"),
  /** Signs the access tokens we issue. */
  jwtSecret: env("MCP_JWT_SECRET") || randomBytes(32).toString("hex"),
  stateDir: env("STATE_DIR", "/var/lib/freetts-mcp"),
  watermarkPath: env("WATERMARK_PATH", "/var/www/freetts.org/audio_assets/watermark.mp3"),
  ffmpeg: env("FFMPEG_PATH", "ffmpeg"),
  // Callers without an account get what a website guest gets.
  anon: {
    perCallChars: Number(env("ANON_PER_CALL_CHARS", "2000")),
    dailyChars: Number(env("ANON_DAILY_CHARS", "2000")),
    hourlyChars: Number(env("ANON_HOURLY_CHARS", "3000")),
    perMinute: Number(env("ANON_PER_MINUTE", "10")),
    /** Guests on claude.ai or ChatGPT all arrive from the platform's servers: one meter per platform. */
    platformDailyChars: Number(env("ANON_PLATFORM_DAILY_CHARS", "60000")),
    platformPerMinute: Number(env("ANON_PLATFORM_PER_MINUTE", "120")),
    /** Everyone without an account together, per day. Protects the Azure bill. */
    poolDailyChars: Number(env("ANON_POOL_DAILY_CHARS", "300000")),
    /** Free audio lives this long under mcp.freetts.org/audio/. */
    keepMs: 60 * 60 * 1000,
  },
  /** How long an access token lives. Refresh tokens rotate on use. */
  accessTokenSeconds: 3600,
  refreshTokenDays: 90,
  authCodeSeconds: 600,
};

export const MCP_PATH = "/mcp";
export const RESOURCE = `${CONFIG.publicUrl}${MCP_PATH}`;
