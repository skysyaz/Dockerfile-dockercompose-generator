import { useState } from "react";

interface GenerateResult {
  framework: string;
  repo_name: string;
  dockerfile: string;
  docker_compose: string;
}

type ActiveTab = "dockerfile" | "compose";

const FRAMEWORKS = [
  "Node.js",
  "Python",
  "Django",
  "Flask",
  "Java",
  "Ruby on Rails",
  "PHP (Laravel)",
  "Go",
  "Rust",
  ".NET",
];

function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("dockerfile");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: repoUrl }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to generate configuration");
      }

      setResult(data);
      setActiveTab("dockerfile");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const activeContent =
    activeTab === "dockerfile" ? result?.dockerfile : result?.docker_compose;
  const activeFilename =
    activeTab === "dockerfile" ? "Dockerfile" : "docker-compose.yml";

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-badge">Docker Configuration Generator</div>
        <h1>Generate Docker configs from any GitHub repo</h1>
        <p>
          Paste a repository URL, and we will clone it, detect the framework,
          and generate a tailored Dockerfile and docker-compose.yml for download.
        </p>
      </header>

      <main className="content">
        <section className="card input-card">
          <form onSubmit={handleSubmit}>
            <label htmlFor="repo-url">GitHub repository URL</label>
            <div className="input-row">
              <input
                id="repo-url"
                type="url"
                placeholder="https://github.com/username/repository"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                required
                disabled={loading}
              />
              <button type="submit" disabled={loading || !repoUrl.trim()}>
                {loading ? "Analyzing..." : "Generate"}
              </button>
            </div>
          </form>

          {error && <div className="error-banner">{error}</div>}
        </section>

        {result && (
          <section className="card result-card">
            <div className="result-header">
              <div>
                <h2>Generated configuration</h2>
                <p>
                  Repository <strong>{result.repo_name}</strong> detected as{" "}
                  <span className="framework-pill">{result.framework}</span>
                </p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  downloadFile(activeFilename, activeContent || "")
                }
              >
                Download {activeFilename}
              </button>
            </div>

            <div className="tabs">
              <button
                type="button"
                className={activeTab === "dockerfile" ? "tab active" : "tab"}
                onClick={() => setActiveTab("dockerfile")}
              >
                Dockerfile
              </button>
              <button
                type="button"
                className={activeTab === "compose" ? "tab active" : "tab"}
                onClick={() => setActiveTab("compose")}
              >
                docker-compose.yml
              </button>
            </div>

            <pre className="code-block">
              <code>{activeContent}</code>
            </pre>

            <div className="download-row">
              <button
                type="button"
                onClick={() =>
                  downloadFile("Dockerfile", result.dockerfile)
                }
              >
                Download Dockerfile
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadFile(
                    "docker-compose.yml",
                    result.docker_compose,
                  )
                }
              >
                Download docker-compose.yml
              </button>
            </div>
          </section>
        )}

        <section className="features">
          <article className="feature">
            <h3>Repository analysis</h3>
            <p>
              Clones the repository and inspects manifest files to identify the
              language and framework.
            </p>
          </article>
          <article className="feature">
            <h3>Tailored Dockerfiles</h3>
            <p>
              Produces build instructions, ports, and startup commands matched to
              your stack.
            </p>
          </article>
          <article className="feature">
            <h3>Compose services</h3>
            <p>
              Adds database services, volumes, and environment variables when
              the framework needs them.
            </p>
          </article>
        </section>

        <section className="card supported-card">
          <h2>Supported frameworks</h2>
          <div className="framework-grid">
            {FRAMEWORKS.map((framework) => (
              <span key={framework} className="framework-chip">
                {framework}
              </span>
            ))}
          </div>
        </section>
      </main>

      <footer className="footer">
        <p>Analyze. Generate. Download. Ship with Docker.</p>
      </footer>
    </div>
  );
}
