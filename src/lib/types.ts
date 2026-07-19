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
  | "unknown";

export interface DetectedService {
  name: "postgres" | "mysql" | "redis" | "mongodb";
  image: string;
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
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
  envVars: DiscoveredEnvVar[];
  existingFiles: string[];
  auditFixes?: string[];
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
