import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getProviderLabel,
  isPrivateGitHost,
  parseGithubUrl,
  parseRepoUrl,
} from "../src/lib/repo-url.ts";

describe("parseRepoUrl", () => {
  it("parses GitHub URLs", () => {
    assert.deepEqual(parseRepoUrl("https://github.com/o/r"), {
      provider: "github",
      host: "github.com",
      projectPath: "o/r",
      repoName: "r",
    });
    assert.deepEqual(parseRepoUrl("https://github.com/o/r.git")?.repoName, "r");
    assert.equal(parseRepoUrl("https://github.com/o/r/tree/main")?.projectPath, "o/r");
  });

  it("parses GitLab URLs including nested groups", () => {
    assert.deepEqual(parseRepoUrl("https://gitlab.com/group/sub/project"), {
      provider: "gitlab",
      host: "gitlab.com",
      projectPath: "group/sub/project",
      repoName: "project",
    });
  });

  it("parses Bitbucket URLs", () => {
    assert.deepEqual(parseRepoUrl("https://bitbucket.org/workspace/repo"), {
      provider: "bitbucket",
      host: "bitbucket.org",
      projectPath: "workspace/repo",
      repoName: "repo",
    });
  });

  it("parses Codeberg URLs", () => {
    assert.deepEqual(parseRepoUrl("https://codeberg.org/owner/repo"), {
      provider: "codeberg",
      host: "codeberg.org",
      projectPath: "owner/repo",
      repoName: "repo",
    });
  });

  it("parses generic Gitea-compatible hosts", () => {
    assert.deepEqual(parseRepoUrl("https://git.example.com/owner/repo"), {
      provider: "gitea",
      host: "git.example.com",
      projectPath: "owner/repo",
      repoName: "repo",
    });
  });

  it("rejects invalid URLs", () => {
    assert.equal(parseRepoUrl("https://example.com"), null);
    assert.equal(parseRepoUrl("not-a-url"), null);
  });
});

describe("parseGithubUrl", () => {
  it("keeps GitHub-only compatibility", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r" });
    assert.equal(parseGithubUrl("https://gitlab.com/o/r"), null);
  });
});

describe("isPrivateGitHost", () => {
  it("blocks loopback, private ranges, and internal names", () => {
    assert.equal(isPrivateGitHost("localhost"), true);
    assert.equal(isPrivateGitHost("localhost:3000"), true);
    assert.equal(isPrivateGitHost("127.0.0.1"), true);
    assert.equal(isPrivateGitHost("10.0.0.5"), true);
    assert.equal(isPrivateGitHost("172.16.1.1"), true);
    assert.equal(isPrivateGitHost("192.168.1.10:8080"), true);
    assert.equal(isPrivateGitHost("169.254.169.254"), true);
    assert.equal(isPrivateGitHost("[::1]"), true);
    assert.equal(isPrivateGitHost("[fe80::1]:3000"), true);
    assert.equal(isPrivateGitHost("git.internal"), true);
    assert.equal(isPrivateGitHost("myserver.local"), true);
    assert.equal(isPrivateGitHost("intranet-host"), true);
  });

  it("allows public hosts", () => {
    assert.equal(isPrivateGitHost("git.example.com"), false);
    assert.equal(isPrivateGitHost("gitea.io"), false);
    assert.equal(isPrivateGitHost("codeberg.org"), false);
    assert.equal(isPrivateGitHost("8.8.8.8"), false);
    assert.equal(isPrivateGitHost("172.32.0.1"), false);
  });
});

describe("getProviderLabel", () => {
  it("returns human-readable provider names", () => {
    assert.equal(getProviderLabel("github"), "GitHub");
    assert.equal(getProviderLabel("gitlab"), "GitLab");
  });
});
