export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "go"
  | "rust"
  | "ruby"
  | "php"
  | "csharp"
  | "kotlin"
  | "scala"
  | "elixir"
  | "swift"
  | "haskell"
  | "cpp"
  | "dart"
  | "clojure"
  | "html"
  | "unknown";

export type Framework =
  | "nextjs"
  | "nuxt"
  | "svelte"
  | "express"
  | "nestjs"
  | "django"
  | "flask"
  | "fastapi"
  | "python"
  | "spring-boot"
  | "java-maven"
  | "java-gradle"
  | "kotlin"
  | "go"
  | "rust"
  | "rails"
  | "sinatra"
  | "ruby"
  | "laravel"
  | "symfony"
  | "php"
  | "dotnet"
  | "nodejs"
  | "react"
  | "vue"
  | "angular"
  | "vite"
  | "phoenix"
  | "elixir"
  | "scala"
  | "swift"
  | "haskell"
  | "deno"
  | "astro"
  | "remix"
  | "gatsby"
  | "fastify"
  | "koa"
  | "hono"
  | "dart"
  | "clojure"
  | "cmake"
  | "static"
  | "unknown";

export interface DetectedService {
  name: "postgres" | "mysql" | "redis" | "mongodb" | "rabbitmq" | "elasticsearch";
  image: string;
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  /** Shell command for a compose healthcheck (emitted as CMD-SHELL). */
  healthcheck?: string;
}

export type RepoProvider = "github" | "gitlab" | "bitbucket" | "codeberg" | "gitea";

export type EnvVarCategory =
  | "database"
  | "cache"
  | "secret"
  | "auth"
  | "framework"
  | "config"
  | "other";

export type EnvVarSource =
  | "env-example"
  | "appsettings"
  | "application-config"
  | "django-settings"
  | "source-scan"
  | "dependency-inference"
  | "framework-default";

export interface DiscoveredEnvVar {
  key: string;
  suggestedValue: string;
  category: EnvVarCategory;
  source: EnvVarSource;
  required: boolean;
  description?: string;
  sensitive?: boolean;
}

export type DatabaseMode = "bundled" | "external";

export interface AnalysisResult {
  repoUrl: string;
  repoName: string;
  repoProvider: RepoProvider;
  language: Language;
  framework: Framework;
  packageManager: string;
  buildTool: string;
  entrypoint: string;
  port: number;
  services: DetectedService[];
  dependencies: string[];
  notes: string[];
  backendSubdir: string;
  dotnetProject: string;
  dotnetSolution: string;
  dotnetSdkVersion: string;
  envVars: DiscoveredEnvVar[];
  rootFiles: string[];
  existingFiles: string[];
  auditFixes?: string[];
  /** Python dependency manager detected from lockfiles (pip/poetry/uv/pipenv/pdm). */
  pythonManager?: "pip" | "poetry" | "uv" | "pipenv" | "pdm";
  /** WSGI/ASGI app module, e.g. "config.wsgi:application" or "app.main:app". */
  wsgiModule?: string;
  /** Go main-package path relative to the build context, e.g. "./cmd/server". */
  goBuildPath?: string;
  /** Compiled binary name (Rust crate / [[bin]] target). */
  binaryName?: string;
  /** Node base image tag derived from package.json engines.node, e.g. "24-alpine". */
  nodeVersion?: string;
  /** Root package.json declares preinstall/install/postinstall/prepare scripts. */
  hasNodeLifecycleScripts?: boolean;
}

export interface Customizations {
  port?: number;
  baseImageVersion?: string;
  extraEnv?: Record<string, string>;
  enabledServices?: string[];
  databaseMode?: DatabaseMode;
  envValues?: Record<string, string>;
}

export interface GeneratedFiles {
  Dockerfile: string;
  "docker-compose.yml": string;
  ".dockerignore": string;
  ".env.example": string;
  ".env"?: string;
}

export interface BuildLogLine {
  t: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}
