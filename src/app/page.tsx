"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { io as ioClient } from "socket.io-client";
import { toast } from "sonner";
import {
  AlertCircle,
  Boxes,
  Check,
  Container,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  Play,
  Plus,
  Server,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/code-block";
import { getProviderLabel, parseRepoUrl } from "@/lib/repo-url";
import type {
  AnalysisResult,
  BuildLogLine,
  DatabaseMode,
  GeneratedFiles,
  RepoProvider,
} from "@/lib/types";

const SAMPLE_REPOS = [
  { label: "Next.js", url: "https://github.com/vercel/commerce" },
  { label: "FastAPI", url: "https://github.com/tiangolo/fastapi" },
  { label: "GitLab", url: "https://gitlab.com/gitlab-org/gitlab-runner" },
  { label: "Django", url: "https://github.com/wsvincent/lithium" },
  { label: "Rails", url: "https://github.com/rails/rails" },
  { label: "Go", url: "https://github.com/gin-gonic/gin" },
  { label: "Rust", url: "https://github.com/seanmonstar/warp" },
  { label: "Spring Boot", url: "https://github.com/spring-projects/spring-petclinic" },
  { label: "Laravel", url: "https://github.com/laravel/laravel" },
];

const TOKEN_HELP: Record<
  RepoProvider,
  { label: string; href: string; scope: string }
> = {
  github: {
    label: "GitHub",
    href: "https://github.com/settings/tokens",
    scope: "repo",
  },
  gitlab: {
    label: "GitLab",
    href: "https://gitlab.com/-/user_settings/personal_access_tokens",
    scope: "read_repository",
  },
  bitbucket: {
    label: "Bitbucket",
    href: "https://bitbucket.org/account/settings/app-passwords/",
    scope: "repository:read",
  },
  codeberg: {
    label: "Codeberg",
    href: "https://codeberg.org/user/settings/applications",
    scope: "read:repository",
  },
  gitea: {
    label: "Gitea",
    href: "https://docs.gitea.com/development/api-usage#authentication",
    scope: "read repository",
  },
};

const LOADING_STEPS = [
  "Cloning repository...",
  "Detecting language & framework...",
  "Analyzing dependencies...",
  "Identifying services (database, cache)...",
  "Discovering environment variables...",
  "Done.",
];

const FILE_TABS = [
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
  ".env",
] as const;

const BUILD_TIMEOUT_SEC = 900;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function getSyntaxLanguage(filename: string): string {
  if (filename === "Dockerfile") return "docker";
  if (filename.endsWith(".yml")) return "yaml";
  return "bash";
}

function envValuesFromAnalysis(analysis: AnalysisResult): Record<string, string> {
  return Object.fromEntries(
    analysis.envVars.map((variable) => [variable.key, variable.suggestedValue]),
  );
}

const ENV_SOURCE_LABELS: Record<string, string> = {
  "env-example": "repo .env",
  appsettings: "appsettings",
  "application-config": "config file",
  "django-settings": "Django",
  "source-scan": "source code",
  "dependency-inference": "dependencies",
  "framework-default": "framework",
};

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [files, setFiles] = useState<GeneratedFiles | null>(null);
  const [tokenProvided, setTokenProvided] = useState(false);
  const [enabledServices, setEnabledServices] = useState<string[]>([]);
  const [customOpen, setCustomOpen] = useState(true);
  const [portOverride, setPortOverride] = useState("");
  const [baseImageVersion, setBaseImageVersion] = useState("");
  const [extraEnv, setExtraEnv] = useState<{ key: string; value: string }[]>([]);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [databaseMode, setDatabaseMode] = useState<DatabaseMode>("bundled");
  const [regenerating, setRegenerating] = useState(false);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [copiedBuildLogs, setCopiedBuildLogs] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [buildLogs, setBuildLogs] = useState<BuildLogLine[]>([]);
  const [buildRunning, setBuildRunning] = useState(false);
  const [buildOnly, setBuildOnly] = useState(true);
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null);
  const [buildElapsedSec, setBuildElapsedSec] = useState(0);
  const [buildDone, setBuildDone] = useState<{
    success: boolean;
    reason?: string;
    exitCode?: number | null;
    buildOnly?: boolean;
  } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<ReturnType<typeof ioClient> | null>(null);

  const detectedProvider = useMemo(
    () => parseRepoUrl(repoUrl.trim())?.provider ?? "github",
    [repoUrl],
  );
  const tokenHelp = TOKEN_HELP[detectedProvider];

  useEffect(() => {
    if (!loading) return;
    const timers = LOADING_STEPS.slice(0, -1).map((_, i) =>
      window.setTimeout(() => setLoadingStep(i + 1), (i + 1) * 1500),
    );
    return () => timers.forEach(clearTimeout);
  }, [loading]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [buildLogs.length]);

  useEffect(() => {
    if (!buildRunning || buildStartedAt === null) return;
    const tick = () => {
      setBuildElapsedSec(Math.floor((Date.now() - buildStartedAt) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [buildRunning, buildStartedAt]);

  const resetAll = useCallback(() => {
    setRepoUrl("");
    setGithubToken("");
    setError(null);
    setAnalysis(null);
    setFiles(null);
    setTokenProvided(false);
    setEnabledServices([]);
    setPortOverride("");
    setBaseImageVersion("");
    setExtraEnv([]);
    setEnvValues({});
    setDatabaseMode("bundled");
    setLoadingStep(0);
  }, []);

  const generateFiles = useCallback(
    async (
      url: string,
      token: string,
      overrides?: {
        port?: number;
        baseImageVersion?: string;
        extraEnv?: Record<string, string>;
        enabledServices?: string[];
        databaseMode?: DatabaseMode;
        envValues?: Record<string, string>;
      },
      options?: { preserveEnvEdits?: boolean },
    ) => {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: url,
          githubToken: token || undefined,
          ...overrides,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Generation failed");
      setFiles(data.files);
      setAnalysis(data.analysis);
      setEnvValues((prev) =>
        options?.preserveEnvEdits
          ? {
              ...envValuesFromAnalysis(data.analysis),
              ...prev,
              ...(overrides?.envValues ?? {}),
            }
          : envValuesFromAnalysis(data.analysis),
      );
      if (data.analysis?.port && overrides?.port) {
        setPortOverride(String(overrides.port));
      }
      setEnabledServices(
        overrides?.enabledServices ??
          data.analysis.services.map((s: { name: string }) => s.name),
      );
      return data;
    },
    [],
  );

  const handleAnalyze = useCallback(
    async (url?: string) => {
      const target = (url ?? repoUrl).trim();
      if (!target) return;
      setLoading(true);
      setError(null);
      setLoadingStep(0);
      setAnalysis(null);
      setFiles(null);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: target,
            githubToken: githubToken || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Analysis failed");
        setTokenProvided(data.tokenProvided);
        setAnalysis(data.analysis);
        setEnvValues(envValuesFromAnalysis(data.analysis));
        setDatabaseMode("bundled");
        setEnabledServices(data.analysis.services.map((s: { name: string }) => s.name));
        await generateFiles(target, githubToken, {
          enabledServices: data.analysis.services.map((s: { name: string }) => s.name),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setLoading(false);
        setLoadingStep(LOADING_STEPS.length - 1);
      }
    },
    [repoUrl, githubToken, generateFiles],
  );

  const handleRegenerate = useCallback(async () => {
    if (!analysis) return;
    setRegenerating(true);
    try {
      const envRecord = Object.fromEntries(
        extraEnv.filter((e) => e.key).map((e) => [e.key, e.value]),
      );
      const port = portOverride ? Number(portOverride) : undefined;
      if (port !== undefined && (port < 1 || port > 65535)) {
        throw new Error("Port must be between 1 and 65535");
      }
      await generateFiles(analysis.repoUrl, githubToken, {
        port,
        baseImageVersion: baseImageVersion || undefined,
        extraEnv: Object.keys(envRecord).length ? envRecord : undefined,
        enabledServices,
        databaseMode,
        envValues: Object.keys(envValues).length ? envValues : undefined,
      }, { preserveEnvEdits: true });
      toast.success("Files regenerated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  }, [
    analysis,
    extraEnv,
    portOverride,
    baseImageVersion,
    githubToken,
    enabledServices,
    databaseMode,
    envValues,
    generateFiles,
  ]);

  const handleServiceToggle = useCallback(
    (serviceName: string, checked: boolean) => {
      setEnabledServices((prev) => {
        const next = checked
          ? [...prev, serviceName]
          : prev.filter((n) => n !== serviceName);
        if (analysis) {
          const envRecord = Object.fromEntries(
            extraEnv.filter((e) => e.key).map((e) => [e.key, e.value]),
          );
          generateFiles(analysis.repoUrl, githubToken, {
            port: portOverride ? Number(portOverride) : undefined,
            baseImageVersion: baseImageVersion || undefined,
            extraEnv: Object.keys(envRecord).length ? envRecord : undefined,
            enabledServices: next,
            databaseMode,
            envValues: Object.keys(envValues).length ? envValues : undefined,
          }, { preserveEnvEdits: true }).catch((err) => {
            toast.error(err instanceof Error ? err.message : "Failed to update services");
          });
        }
        return next;
      });
    },
    [analysis, extraEnv, portOverride, baseImageVersion, githubToken, enabledServices, databaseMode, envValues, generateFiles],
  );

  const handleDatabaseModeChange = useCallback(
    async (mode: DatabaseMode) => {
      setDatabaseMode(mode);
      if (!analysis) return;
      const envRecord = Object.fromEntries(
        extraEnv.filter((e) => e.key).map((e) => [e.key, e.value]),
      );
      try {
        const data = await generateFiles(analysis.repoUrl, githubToken, {
          port: portOverride ? Number(portOverride) : undefined,
          baseImageVersion: baseImageVersion || undefined,
          extraEnv: Object.keys(envRecord).length ? envRecord : undefined,
          enabledServices,
          databaseMode: mode,
          envValues: Object.keys(envValues).length ? envValues : undefined,
        });
        if (data?.analysis) {
          setEnvValues((prev) => {
            const next = { ...prev };
            for (const variable of data.analysis.envVars) {
              if (variable.category === "database") {
                next[variable.key] = variable.suggestedValue;
              }
            }
            return next;
          });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update database mode");
      }
    },
    [
      analysis,
      extraEnv,
      portOverride,
      baseImageVersion,
      githubToken,
      enabledServices,
      envValues,
      generateFiles,
    ],
  );

  const handleEnvValueChange = useCallback((key: string, value: string) => {
    setEnvValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const hasCustomChanges =
    Boolean(
      portOverride ||
        baseImageVersion ||
        extraEnv.some((e) => e.key) ||
        databaseMode !== "bundled" ||
        (analysis &&
          analysis.envVars.some(
            (variable) => envValues[variable.key] !== variable.suggestedValue,
          )),
    );

  const downloadZip = async () => {
    if (!files) return;
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      if (content) zip.file(name, content);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${analysis?.repoName ?? "dockgen"}-docker-config.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyFile = async (name: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedFile(name);
    setTimeout(() => setCopiedFile(null), 1500);
  };

  const formatBuildLogs = (logs: BuildLogLine[]) =>
    logs
      .map((line) => `${new Date(line.t).toLocaleTimeString()}${line.text}`)
      .join("\n");

  const copyBuildLogs = async () => {
    if (!buildLogs.length) return;
    await navigator.clipboard.writeText(formatBuildLogs(buildLogs));
    setCopiedBuildLogs(true);
    setTimeout(() => setCopiedBuildLogs(false), 1500);
  };

  const startBuild = async () => {
    if (!analysis || !files) return;
    setBuildOpen(true);
    setBuildLogs([]);
    setBuildRunning(true);
    setBuildDone(null);
    setBuildStartedAt(Date.now());
    setBuildElapsedSec(0);

    try {
      const tokenRes = await fetch("/api/build-token");
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        setBuildRunning(false);
        setBuildDone({ success: false, reason: "disabled" });
        toast.error(tokenData.detail || "Test Build is disabled");
        return;
      }

      const buildSocketPath = "/build-socket";
      const buildServiceUrl =
        process.env.NEXT_PUBLIC_BUILD_SERVICE_URL || window.location.origin;
      const socket = ioClient(buildServiceUrl, {
        path: buildSocketPath,
        transports: ["websocket", "polling"],
        reconnection: false,
        timeout: 15000,
        forceNew: true,
        auth: { token: tokenData.token },
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        const fileList = Object.entries(files)
          .filter(([, content]) => content)
          .map(([name, content]) => ({ name, content }));
        socket.emit("build", {
          repoUrl: analysis.repoUrl,
          githubToken: githubToken || undefined,
          files: fileList,
          timeoutSec: BUILD_TIMEOUT_SEC,
          buildOnly,
          cloneRepo: true,
        });
      });

      socket.on("log", (line: BuildLogLine) => {
        setBuildLogs((prev) => [...prev, line]);
      });

      socket.on(
        "done",
        (payload: {
          success: boolean;
          reason?: string;
          exitCode?: number | null;
          buildOnly?: boolean;
        }) => {
          setBuildRunning(false);
          setBuildDone(payload);
        },
      );

      socket.on("connect_error", (err: Error) => {
        setBuildRunning(false);
        setBuildDone({ success: false, reason: err.message || "connect-error" });
      });
    } catch {
      setBuildRunning(false);
      setBuildDone({ success: false, reason: "connect-error" });
    }
  };

  const closeBuild = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setBuildOpen(false);
    setBuildStartedAt(null);
    setBuildElapsedSec(0);
  };

  const visibleFiles = FILE_TABS.filter((f) => files?.[f as keyof GeneratedFiles]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 bg-card/30 backdrop-blur-sm border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-lg bg-emerald-500 flex items-center justify-center">
              <Container className="size-5 text-emerald-950" />
            </div>
            <div>
              <div className="font-semibold">DockGen</div>
              <div className="text-xs text-muted-foreground">Docker Config Generator</div>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="size-4" />
            GitHub · GitLab · Bitbucket · Codeberg · Gitea
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8 md:py-12 max-w-5xl">
        {!analysis && (
          <section className="max-w-3xl mx-auto text-center mb-8">
            <Badge className="mb-4 bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10">
              <Sparkles className="size-3 mr-1" />
              Auto-detects 15+ frameworks · private repos · live build testing
            </Badge>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
              Dockerize any git repo{" "}
              <span className="text-emerald-500">in seconds</span>
            </h1>
            <p className="text-muted-foreground text-lg">
              Paste a URL from GitHub, GitLab, Bitbucket, Codeberg, or any Gitea-compatible host.
              DockGen generates production-ready{" "}
              <code className="font-mono text-sm">Dockerfile</code>,{" "}
              <code className="font-mono text-sm">docker-compose.yml</code>,{" "}
              <code className="font-mono text-sm">.env</code>, and{" "}
              <code className="font-mono text-sm">.env.example</code>.
            </p>
          </section>
        )}

        {!analysis && (
          <Card className="max-w-3xl mx-auto p-4 md:p-6 space-y-4 mb-8">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleAnalyze();
              }}
              className="space-y-4"
            >
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    className="pl-9 h-11"
                    placeholder="https://github.com/owner/repo · gitlab.com · bitbucket.org · codeberg.org"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={loading || !repoUrl.trim()}
                  className="h-11 bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
                  size="lg"
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Analyzing
                    </>
                  ) : (
                    <>
                      <Terminal className="size-4" />
                      Analyze
                    </>
                  )}
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-2">
                  <Lock className="size-3.5" />
                  {tokenHelp.label} token (optional — required for private repos)
                </Label>
                <div className="relative flex gap-2">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    type={showToken ? "text" : "password"}
                    className="pl-9 font-mono"
                    placeholder="Personal access token"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    disabled={loading}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowToken(!showToken)}
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Token is sent only to the server, used for downloading the repo archive, and never
                  stored. Create one in{" "}
                  <a
                    href={tokenHelp.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-500 hover:underline"
                  >
                    {tokenHelp.label} settings
                  </a>{" "}
                  with <code className="font-mono">{tokenHelp.scope}</code> scope.
                </p>
              </div>
            </form>

            {!loading && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Try a sample repo</Label>
                <div className="flex flex-wrap gap-2">
                  {SAMPLE_REPOS.map((sample) => (
                    <button
                      key={sample.url}
                      type="button"
                      className="text-xs rounded-full border px-3 py-1 hover:bg-accent transition-colors"
                      onClick={() => {
                        setRepoUrl(sample.url);
                        handleAnalyze(sample.url);
                      }}
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loading && (
              <div className="space-y-2">
                <Label>Progress</Label>
                {LOADING_STEPS.map((step, i) => (
                  <div key={step} className="flex items-center gap-2 text-sm">
                    {i < loadingStep ? (
                      <Check className="size-4 text-emerald-500" />
                    ) : i === loadingStep ? (
                      <Loader2 className="size-4 animate-spin text-emerald-500" />
                    ) : (
                      <div className="size-4 rounded-full border border-muted-foreground/30" />
                    )}
                    <span className={i <= loadingStep ? "text-foreground" : "text-muted-foreground"}>
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {error && !loading && (
          <Alert variant="destructive" className="max-w-3xl mx-auto mb-6">
            <AlertCircle className="size-4" />
            <AlertTitle>Generation failed</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>{error}</span>
              <Button variant="outline" size="sm" className="w-fit" onClick={resetAll}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {analysis && files && (
          <>
            <Card className="mb-6 border-emerald-500/30">
              <CardHeader>
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Check className="size-5 text-emerald-500" />
                      Configuration generated
                    </CardTitle>
                    <CardDescription className="mt-1">
                      <a
                        href={analysis.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-emerald-500 hover:underline"
                      >
                        {analysis.repoUrl}
                      </a>
                      {tokenProvided && (
                        <Badge variant="outline" className="ml-2 text-emerald-500 border-emerald-500/30">
                          authed
                        </Badge>
                      )}
                      <Badge variant="outline" className="ml-2 text-muted-foreground">
                        {getProviderLabel(analysis.repoProvider)}
                      </Badge>
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={resetAll}>
                      New repo
                    </Button>
                    <Button
                      variant="outline"
                      className="border-emerald-500/50 text-emerald-500"
                      onClick={startBuild}
                    >
                      <Play className="size-4" />
                      Test build
                    </Button>
                    <Button
                      className="bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
                      onClick={downloadZip}
                    >
                      <Download className="size-4" />
                      Download ZIP
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 px-6 pb-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="build-only"
                      checked={buildOnly}
                      onCheckedChange={(checked) => setBuildOnly(checked === true)}
                      disabled={buildRunning}
                    />
                    <Label htmlFor="build-only" className="text-sm font-normal cursor-pointer">
                      Build only{" "}
                      <span className="text-muted-foreground">
                        (docker compose build — recommended)
                      </span>
                    </Label>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Timeout: {Math.floor(BUILD_TIMEOUT_SEC / 60)} min · validates image builds before Dokploy deploy
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {analysis.existingFiles?.length > 0 && (
                  <Badge className="bg-amber-500/10 text-amber-300 border-amber-500/30">
                    Existing Docker files audited: {analysis.existingFiles.join(", ")}
                  </Badge>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    ["Language", analysis.language],
                    ["Framework", analysis.framework],
                    ["Package Mgr", analysis.packageManager],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-mono text-sm mt-1 text-foreground">{value}</div>
                    </div>
                  ))}
                  <div className="rounded-lg border p-3 space-y-1">
                    <Label className="text-xs text-muted-foreground">Port</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        className="h-8 font-mono text-sm text-foreground"
                        value={portOverride || String(analysis.port)}
                        onChange={(e) => setPortOverride(e.target.value)}
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 bg-emerald-500 hover:bg-emerald-600 text-emerald-950 shrink-0"
                        disabled={regenerating}
                        onClick={handleRegenerate}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                </div>

                {analysis.services.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>
                        Detected Services ({enabledServices.length}/{analysis.services.length} enabled)
                      </Label>
                      <button
                        type="button"
                        className="text-xs text-emerald-500 hover:underline"
                        onClick={() => setCustomOpen(true)}
                      >
                        Customize
                      </button>
                    </div>
                    {analysis.services.map((svc) => {
                      const checked = enabledServices.includes(svc.name);
                      return (
                        <label
                          key={svc.name}
                          className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer ${
                            checked
                              ? "border-emerald-500/50 bg-emerald-500/5"
                              : "opacity-60"
                          }`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(c) =>
                              handleServiceToggle(svc.name, c === true)
                            }
                          />
                          <div className="font-mono text-sm">{svc.name}</div>
                          <div className="font-mono text-xs text-muted-foreground truncate">
                            {svc.image}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}

                {analysis.envVars.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label>
                        Environment Variables ({analysis.envVars.filter((v) => v.required).length} required)
                      </Label>
                      {analysis.services.some(
                        (service) =>
                          service.name === "postgres" ||
                          service.name === "mysql" ||
                          service.name === "mongodb",
                      ) && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">Database:</span>
                          <Button
                            type="button"
                            size="sm"
                            variant={databaseMode === "bundled" ? "default" : "outline"}
                            className={
                              databaseMode === "bundled"
                                ? "h-7 bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
                                : "h-7"
                            }
                            onClick={() => handleDatabaseModeChange("bundled")}
                          >
                            In Compose
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={databaseMode === "external" ? "default" : "outline"}
                            className={
                              databaseMode === "external"
                                ? "h-7 bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
                                : "h-7"
                            }
                            onClick={() => handleDatabaseModeChange("external")}
                          >
                            External
                          </Button>
                        </div>
                      )}
                    </div>
                    {databaseMode === "external" && (
                      <p className="text-xs text-muted-foreground">
                        Database services are excluded from docker-compose. Fill in your real database host, credentials, and connection strings below.
                      </p>
                    )}
                    <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                      {analysis.envVars.map((variable) => (
                        <div
                          key={variable.key}
                          className="rounded-lg border p-3 space-y-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="text-xs font-semibold">{variable.key}</code>
                            {variable.required && (
                              <Badge variant="outline" className="text-[10px]">
                                required
                              </Badge>
                            )}
                            <Badge variant="secondary" className="text-[10px]">
                              {variable.category}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              {ENV_SOURCE_LABELS[variable.source] ?? variable.source}
                            </Badge>
                          </div>
                          <Input
                            className="font-mono text-xs"
                            type={variable.sensitive ? "password" : "text"}
                            value={envValues[variable.key] ?? variable.suggestedValue}
                            onChange={(e) =>
                              handleEnvValueChange(variable.key, e.target.value)
                            }
                          />
                          {variable.description && (
                            <p className="text-xs text-muted-foreground">
                              {variable.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
                      disabled={regenerating}
                      onClick={handleRegenerate}
                    >
                      {regenerating ? <Loader2 className="size-4 animate-spin" /> : null}
                      Apply environment values
                    </Button>
                  </div>
                )}

                {analysis.notes.length > 0 && (
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {analysis.notes.map((note) => (
                      <li key={note} className="flex items-start gap-2">
                        <span className="text-emerald-500">•</span>
                        {note}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Collapsible open={customOpen} onOpenChange={setCustomOpen} className="mb-6">
              <Card>
                <CollapsibleTrigger asChild>
                  <button type="button" className="w-full text-left p-6 flex items-center gap-2">
                    <Settings2 className="size-4 text-emerald-500" />
                    <div>
                      <div className="font-semibold">Build Customization</div>
                      <div className="text-sm text-muted-foreground">
                        Override port, base image version, or add custom environment variables.
                      </div>
                    </div>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="space-y-4 border-t pt-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Port override</Label>
                        <Input
                          type="number"
                          placeholder={`Default: ${analysis.port}`}
                          value={portOverride}
                          onChange={(e) => setPortOverride(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Base image version</Label>
                        <Input
                          className="font-mono"
                          placeholder="e.g. 20-alpine"
                          value={baseImageVersion}
                          onChange={(e) => setBaseImageVersion(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Custom environment variables</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setExtraEnv((prev) => [...prev, { key: "", value: "" }])}
                        >
                          <Plus className="size-4" />
                          Add variable
                        </Button>
                      </div>
                      {extraEnv.map((row, i) => (
                        <div key={i} className="flex gap-2">
                          <Input
                            className="font-mono"
                            placeholder="KEY"
                            value={row.key}
                            onChange={(e) => {
                              const next = [...extraEnv];
                              next[i] = { ...next[i], key: e.target.value };
                              setExtraEnv(next);
                            }}
                          />
                          <Input
                            className="font-mono"
                            placeholder="value"
                            value={row.value}
                            onChange={(e) => {
                              const next = [...extraEnv];
                              next[i] = { ...next[i], value: e.target.value };
                              setExtraEnv(next);
                            }}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setExtraEnv((prev) => prev.filter((_, j) => j !== i))}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="bg-emerald-500 hover:bg-emerald-600 text-emerald-950"
                        disabled={regenerating}
                        onClick={handleRegenerate}
                      >
                        {regenerating ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        Apply & regenerate
                      </Button>
                      {hasCustomChanges && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setPortOverride("");
                            setBaseImageVersion("");
                            setExtraEnv([]);
                            if (analysis) setEnvValues(envValuesFromAnalysis(analysis));
                            setDatabaseMode("bundled");
                          }}
                        >
                          Reset
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>

            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="size-4 text-emerald-500" />
                  Generated Files
                </CardTitle>
                <CardDescription>
                  Copy or download individual files. Drop them at the root of your repository.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="Dockerfile">
                  <TabsList className="flex-wrap h-auto">
                    {visibleFiles.map((file) => (
                      <TabsTrigger key={file} value={file} className="font-mono text-xs">
                        {file}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {visibleFiles.map((file) => {
                    const content = files[file as keyof GeneratedFiles] ?? "";
                    return (
                      <TabsContent key={file} value={file} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            {content.split("\n").length} lines · {content.length} chars
                          </span>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => copyFile(file, content)}
                            >
                              {copiedFile === file ? (
                                <>
                                  <Check className="size-3" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="size-3" />
                                  Copy
                                </>
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const blob = new Blob([content], { type: "text/plain" });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = file;
                                a.click();
                                URL.revokeObjectURL(url);
                              }}
                            >
                              <Download className="size-3" />
                              Download
                            </Button>
                          </div>
                        </div>
                        <CodeBlock
                          content={content}
                          language={getSyntaxLanguage(file)}
                        />
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </CardContent>
            </Card>

            <Card className="bg-muted/30 mb-6">
              <CardContent className="p-6 flex gap-4">
                <div className="size-9 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <Terminal className="size-5 text-emerald-500" />
                </div>
                <div>
                  <h3 className="font-semibold mb-2">How to use these files</h3>
                  <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                    <li>Copy generated files to repo root</li>
                    <li>Copy <code className="font-mono">.env.example</code> to <code className="font-mono">.env</code> (or use the ready-to-use <code className="font-mono">.env</code> we generated)</li>
                    <li>
                      Build and start:{" "}
                      <code className="font-mono bg-muted px-2 py-0.5 rounded">
                        docker compose up --build -d
                      </code>
                    </li>
                    <li>
                      Open{" "}
                      <code className="font-mono bg-muted px-2 py-0.5 rounded">
                        http://localhost:{portOverride || analysis.port}
                      </code>{" "}
                      in browser
                    </li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {!analysis && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
            {[
              {
                icon: Boxes,
                title: "20+ languages & frameworks",
                text: "Next.js, Nuxt, Svelte, Express, NestJS, Django, Flask, FastAPI, Spring Boot, Rails, Laravel, Phoenix, Elixir, Scala, Kotlin, Go, Rust, .NET, Deno, Swift, Haskell, and more.",
              },
              {
                icon: Server,
                title: "Smart service detection",
                text: "Auto-adds Postgres, MySQL, MongoDB, and Redis containers based on the dependencies in your package.json, requirements.txt, Gemfile, etc.",
              },
              {
                icon: Layers,
                title: "Multi-stage builds",
                text: "Generated Dockerfiles use multi-stage builds to keep final images small. Production-ready, not just a tutorial.",
              },
            ].map((feature) => (
              <Card key={feature.title}>
                <CardContent className="p-6">
                  <feature.icon className="size-5 text-emerald-500 mb-3" />
                  <h3 className="font-semibold mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.text}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <footer className="mt-auto border-t py-6">
        <div className="container mx-auto px-4 flex flex-col sm:flex-row justify-between gap-2 text-sm text-muted-foreground">
          <span>DockGen · Self-hostable · Generated configs are MIT-licensed</span>
          <span>
            Powered by{" "}
            <a href="https://nextjs.org" target="_blank" rel="noreferrer" className="hover:text-emerald-500">
              Next.js
            </a>{" "}
            ·{" "}
            <a href="https://docker.com" target="_blank" rel="noreferrer" className="hover:text-emerald-500">
              Docker
            </a>
          </span>
        </div>
      </footer>

      <Dialog open={buildOpen} onOpenChange={(open) => !open && closeBuild()}>
        <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="size-4 text-emerald-500" />
              Test Build · Live Logs
            </DialogTitle>
            <DialogDescription>
              {buildOnly ? (
                <>
                  Cloning the repo, writing your generated Docker files, and running{" "}
                  <code className="font-mono">docker compose build</code> on the server to
                  verify the image compiles.
                </>
              ) : (
                <>
                  Cloning the repo, writing your generated Docker files, and running{" "}
                  <code className="font-mono">docker compose up --build</code> on the server.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            {buildRunning ? (
              <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30">
                <Loader2 className="size-3 mr-1 animate-spin" />
                {buildOnly ? "Building image" : "Building & starting"}
                {buildStartedAt !== null ? ` · ${formatElapsed(buildElapsedSec)}` : ""}
              </Badge>
            ) : buildDone?.success ? (
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                <Check className="size-3 mr-1" />
                {buildDone.buildOnly !== false ? "Image built successfully" : "Build succeeded"}
                {buildElapsedSec > 0 ? ` · ${formatElapsed(buildElapsedSec)}` : ""}
              </Badge>
            ) : buildDone ? (
              <Badge variant="destructive">
                Build failed
                {buildDone.reason ? ` · ${buildDone.reason}` : ""}
                {buildElapsedSec > 0 ? ` · ${formatElapsed(buildElapsedSec)}` : ""}
              </Badge>
            ) : null}
            <div className="flex items-center gap-2 ml-auto">
              {(buildRunning || buildDone) && buildElapsedSec > 0 && (
                <span className="text-xs font-mono text-muted-foreground tabular-nums">
                  Elapsed: {formatElapsed(buildElapsedSec)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{buildLogs.length} log lines</span>
              <Button
                variant="outline"
                size="sm"
                onClick={copyBuildLogs}
                disabled={buildLogs.length === 0}
              >
                {copiedBuildLogs ? (
                  <>
                    <Check className="size-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    Copy logs
                  </>
                )}
              </Button>
            </div>
          </div>
          <div
            className="flex-1 rounded-lg border overflow-y-auto p-3 font-mono text-xs leading-relaxed"
            style={{ background: "oklch(0.18 0 0)" }}
          >
            {buildRunning && buildElapsedSec >= 30 && (
              <p className="italic text-amber-300/80 mb-3">
                Still working — large repos (Java, Rust, etc.) can take several minutes between
                log lines. Elapsed: {formatElapsed(buildElapsedSec)}.
              </p>
            )}
            {buildLogs.length === 0 ? (
              <p className="italic text-muted-foreground">
                {buildRunning
                  ? `Connecting to build service${buildElapsedSec > 0 ? ` · ${formatElapsed(buildElapsedSec)}` : ""}...`
                  : "Connecting to build service..."}
              </p>
            ) : (
              buildLogs.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  <span className="text-muted-foreground mr-2">
                    {new Date(line.t).toLocaleTimeString()}
                  </span>
                  <span
                    className={
                      line.stream === "stderr"
                        ? "text-red-300"
                        : line.stream === "system"
                          ? "text-emerald-300"
                          : "text-zinc-200"
                    }
                  >
                    {line.text}
                  </span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
          <Button variant="outline" onClick={closeBuild}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
