import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateGitHost,
  parseRepoUrl,
  resolveAccessToken,
} from "../mini-services/docker-build-service/repo-providers.js";

describe("build-service repo providers", () => {
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });

  it("parses GitHub tree URLs", () => {
    assert.deepEqual(parseRepoUrl("https://github.com/skysyaz/sky-bloom-shop/tree/main"), {
      provider: "github",
      host: "github.com",
      projectPath: "skysyaz/sky-bloom-shop",
      repoName: "sky-bloom-shop",
    });
  });

  it("prefers request tokens over server environment tokens", () => {
    process.env.GITHUB_TOKEN = "env-token";
    assert.equal(resolveAccessToken("github", "request-token"), "request-token");
  });

  it("falls back to GITHUB_TOKEN for GitHub repos", () => {
    process.env.GITHUB_TOKEN = "env-token";
    assert.equal(resolveAccessToken("github"), "env-token");
    assert.equal(resolveAccessToken("github", "   "), "env-token");
  });

  it("never sends one provider's token to another provider", () => {
    process.env.GITHUB_TOKEN = "gh-token";
    assert.equal(resolveAccessToken("gitlab", undefined, "gitlab.com"), undefined);
    assert.equal(resolveAccessToken("gitea", undefined, "git.example.com"), undefined);
    assert.equal(resolveAccessToken("codeberg", undefined, "codeberg.org"), undefined);
  });

  it("pins GITLAB_TOKEN to official or explicitly configured hosts", () => {
    const original = process.env.GITLAB_TOKEN;
    const originalHost = process.env.GITLAB_HOST;
    process.env.GITLAB_TOKEN = "gl-token";
    delete process.env.GITLAB_HOST;
    try {
      assert.equal(resolveAccessToken("gitlab", undefined, "gitlab.com"), "gl-token");
      assert.equal(resolveAccessToken("gitlab", undefined, "sub.gitlab.com"), "gl-token");
      assert.equal(resolveAccessToken("gitlab", undefined, "gitlab.evil.com"), undefined);
      process.env.GITLAB_HOST = "gitlab.mycompany.io";
      assert.equal(resolveAccessToken("gitlab", undefined, "gitlab.mycompany.io"), "gl-token");
      assert.equal(resolveAccessToken("gitlab", undefined, "gitlab.evil.com"), undefined);
    } finally {
      if (original === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = original;
      if (originalHost === undefined) delete process.env.GITLAB_HOST;
      else process.env.GITLAB_HOST = originalHost;
    }
  });

  it("pins GITEA_TOKEN to the configured GITEA_HOST", () => {
    const original = process.env.GITEA_TOKEN;
    const originalHost = process.env.GITEA_HOST;
    process.env.GITEA_TOKEN = "gitea-token";
    process.env.GITEA_HOST = "codeberg.org";
    try {
      assert.equal(resolveAccessToken("codeberg", undefined, "codeberg.org"), "gitea-token");
      assert.equal(resolveAccessToken("gitea", undefined, "git.example.com"), undefined);
      delete process.env.GITEA_HOST;
      assert.equal(resolveAccessToken("codeberg", undefined, "codeberg.org"), undefined);
    } finally {
      if (original === undefined) delete process.env.GITEA_TOKEN;
      else process.env.GITEA_TOKEN = original;
      if (originalHost === undefined) delete process.env.GITEA_HOST;
      else process.env.GITEA_HOST = originalHost;
    }
  });

  it("mirrors the private-host SSRF guard", () => {
    assert.equal(isPrivateGitHost("localhost:3000"), true);
    assert.equal(isPrivateGitHost("192.168.1.10"), true);
    assert.equal(isPrivateGitHost("git.example.com"), false);
  });
});
