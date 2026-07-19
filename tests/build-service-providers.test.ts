import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
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
});
