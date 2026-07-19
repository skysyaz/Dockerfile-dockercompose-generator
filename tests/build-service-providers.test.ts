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
    assert.equal(resolveAccessToken("gitlab"), undefined);
    assert.equal(resolveAccessToken("gitea"), undefined);
    assert.equal(resolveAccessToken("codeberg"), undefined);
  });

  it("uses GITEA_TOKEN for gitea-compatible hosts", () => {
    const original = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "gitea-token";
    try {
      assert.equal(resolveAccessToken("gitea"), "gitea-token");
      assert.equal(resolveAccessToken("codeberg"), "gitea-token");
    } finally {
      if (original === undefined) delete process.env.GITEA_TOKEN;
      else process.env.GITEA_TOKEN = original;
    }
  });

  it("mirrors the private-host SSRF guard", () => {
    assert.equal(isPrivateGitHost("localhost:3000"), true);
    assert.equal(isPrivateGitHost("192.168.1.10"), true);
    assert.equal(isPrivateGitHost("git.example.com"), false);
  });
});
