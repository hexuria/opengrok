import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX_CACHE_DIR = "cursor-sandbox-cache";
let cachedSessionId: string | undefined;

function generateSessionId(): string {
  return randomBytes(16).toString("hex");
}

function getSessionId(): string {
  if (!cachedSessionId) {
    cachedSessionId = generateSessionId();
  }
  return cachedSessionId;
}

export function getSandboxCacheEnv() {
  const cacheRoot = join(tmpdir(), SANDBOX_CACHE_DIR, getSessionId());
  return {
    // npm
    NPM_CONFIG_CACHE: join(cacheRoot, "npm"),
    // pnpm
    PNPM_STORE_PATH: join(cacheRoot, "pnpm-store"),
    // Go
    GOCACHE: join(cacheRoot, "go-build"),
    GOMODCACHE: join(cacheRoot, "go-mod"),
    // Cargo/Rust - only redirect build artifacts, NOT CARGO_HOME/RUSTUP_HOME
    // which contain toolchain binaries (cargo, rustc, etc.)
    CARGO_TARGET_DIR: join(cacheRoot, "cargo-target"),
    // pip / uv
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    UV_CACHE_DIR: join(cacheRoot, "uv"),
    // Bun
    BUN_INSTALL_CACHE_DIR: join(cacheRoot, "bun"),
    // Yarn
    YARN_CACHE_FOLDER: join(cacheRoot, "yarn"),
    // node-gyp
    npm_config_devdir: join(cacheRoot, "node-gyp"),
    // Playwright
    PLAYWRIGHT_BROWSERS_PATH: join(cacheRoot, "playwright"),
    // Puppeteer
    PUPPETEER_CACHE_DIR: join(cacheRoot, "puppeteer"),
    // Turbo
    TURBO_CACHE_DIR: join(cacheRoot, "turbo"),
    // Gradle (Java/Kotlin/Android)
    GRADLE_USER_HOME: join(cacheRoot, "gradle"),
    // Conda/Mamba (Python data science)
    CONDA_PKGS_DIRS: join(cacheRoot, "conda"),
    // Poetry (Python)
    POETRY_CACHE_DIR: join(cacheRoot, "poetry"),
    // Ruby - only redirect spec cache, NOT GEM_HOME which contains installed gems with executables
    GEM_SPEC_CACHE: join(cacheRoot, "gem-specs"),
    BUNDLE_PATH: join(cacheRoot, "bundle"),
    // Composer (PHP)
    COMPOSER_HOME: join(cacheRoot, "composer"),
    // Homebrew (macOS)
    HOMEBREW_CACHE: join(cacheRoot, "homebrew"),
    // Cypress (E2E testing)
    CYPRESS_CACHE_FOLDER: join(cacheRoot, "cypress"),
    // nx (monorepo)
    NX_CACHE_DIRECTORY: join(cacheRoot, "nx"),
    // .NET/NuGet
    NUGET_PACKAGES: join(cacheRoot, "nuget"),
    // ccache (C/C++ compilation)
    CCACHE_DIR: join(cacheRoot, "ccache"),
    // CocoaPods (iOS)
    CP_HOME_DIR: join(cacheRoot, "cocoapods"),
    // NOTE: We intentionally do NOT redirect the following "HOME" variables
    // because they contain toolchain binaries, not just caches:
    // - CARGO_HOME (~/.cargo/bin/cargo, rustc, etc.)
    // - RUSTUP_HOME (~/.rustup toolchains)
    // - VOLTA_HOME (~/.volta/bin/node, npm, etc.)
    // - GEM_HOME (installed gems with executables)
    // - PIPX_HOME (virtual envs with CLI tools)
    // - DENO_DIR (compiled binaries)
  };
}
