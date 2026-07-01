import { invoke } from "@tauri-apps/api/core";

import type {
  GithubAccessTokenResponse,
  GithubAvailableRepository,
  GithubDeviceCodeResponse,
  GithubPanelState,
  GithubUserProfile,
  GitHubTimelineEvent,
  GitRepositoryInfo,
} from "./types";

type GitHubRepoApiResponse = {
  default_branch: string;
  full_name: string;
  html_url: string;
  name: string;
  owner?: GitHubOwnerApiResponse | null;
  private: boolean;
};

type GitHubUserRepoApiResponse = GitHubRepoApiResponse & {
  updated_at?: string;
};

type GitHubInstallationApiResponse = {
  id: number;
};

type GitHubInstallationsApiResponse = {
  installations: GitHubInstallationApiResponse[];
};

type GitHubInstallationRepositoriesApiResponse = {
  repositories: GitHubUserRepoApiResponse[];
};

type GitHubUserApiResponse = {
  avatar_url: string;
  html_url: string;
  login: string;
  name?: string | null;
};

type GitHubOwnerApiResponse = {
  avatar_url?: string | null;
  html_url?: string | null;
  login?: string | null;
};

type GitHubCommitApiResponse = {
  author?: {
    login?: string;
  } | null;
  html_url: string;
  sha: string;
  commit: {
    author?: {
      date?: string;
      name?: string;
    };
    message: string;
  };
};

type GitHubIssueApiResponse = {
  closed_at?: string | null;
  html_url: string;
  number: number;
  pull_request?: unknown;
  state: string;
  title: string;
  updated_at: string;
  user?: {
    login?: string;
  } | null;
};

type GitHubPullApiResponse = {
  closed_at?: string | null;
  html_url: string;
  merged_at?: string | null;
  number: number;
  state: string;
  title: string;
  updated_at: string;
  user?: {
    login?: string;
  } | null;
};

type GithubAppSessionApiResponse = {
  state: string;
  status: "pending" | "connected";
  installUrl?: string;
  setupAction?: string;
};

type GithubRepositoriesApiResponse = {
  repositories: GithubAvailableRepository[];
  user?: GithubUserProfile;
};

type GithubRepositoryPreviewApiResponse = {
  events: GitHubTimelineEvent[];
  repository: GitRepositoryInfo;
};

const PAIM_API_BASE_URL = (
  (import.meta.env.VITE_PAIM_API_BASE_URL as string | undefined) || "http://127.0.0.1:8000"
).replace(/\/$/, "");
const GITHUB_CLIENT_ID = (
  (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ||
  (import.meta.env.VITE_GITHUB_APP_CLIENT_ID as string | undefined) ||
  ""
).trim();
const GITHUB_CLIENT_ID_STORAGE_KEY = "paim.githubClientId.v1";
const GITHUB_LOGIN_CONFIG_ERROR_MESSAGE =
  "이 앱 빌드에는 GitHub 로그인이 아직 설정되어 있지 않습니다. 개발팀에 문의해 주세요.";
const GITHUB_LOGIN_SCOPE = "public_repo read:user";
const GITHUB_PRIVATE_REPO_SCOPE = "repo";

function canUseTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

// GitHub URL 입력값을 API 호출에 필요한 owner/repo로 정규화한다.
function parseGithubRepositoryUrl(rawUrl: string) {
  const trimmedUrl = rawUrl.trim().replace(/\.git$/, "");
  const sshMatch = trimmedUrl.match(/^git@github\.com:([^/]+)\/([^/]+)$/);

  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  try {
    const url = new URL(trimmedUrl.startsWith("http") ? trimmedUrl : `https://${trimmedUrl}`);

    if (url.hostname !== "github.com") {
      return null;
    }

    const [owner, repo] = url.pathname.split("/").filter(Boolean);

    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

// PaiM 백엔드 JSON API를 같은 에러 형태로 호출한다.
export async function fetchPaimJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PAIM_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof payload?.detail === "string" ? payload.detail : "PaiM API 요청 실패";

    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error) {
    return error;
  }

  return error instanceof Error && error.message ? error.message : fallback;
}

export function getGithubOAuthErrorMessage(
  error: string | undefined,
  description: string | undefined,
  fallback: string,
) {
  if (error === "device_flow_disabled") {
    return "GitHub App 설정에서 Device Flow를 켜야 로그인할 수 있습니다.";
  }

  if (error === "incorrect_client_credentials") {
    return "GitHub 로그인 설정이 올바르지 않습니다. 개발팀에 문의해 주세요.";
  }

  return description || fallback;
}

// GitHub이 scope 문자열을 안 주는 환경은 막지 않고, 명시적으로 부족할 때만 private 접근을 막는다.
export function hasGithubPrivateRepoScope(scope: string | undefined) {
  const scopes = (scope ?? "").split(/[,\s]+/).filter(Boolean);

  return scopes.length === 0 || scopes.includes(GITHUB_PRIVATE_REPO_SCOPE);
}

function githubTimestamp(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

// GitHub API 응답 세 종류를 우측 패널 타임라인 이벤트로 합친다.
function createGithubEvents(
  commits: GitHubCommitApiResponse[],
  issues: GitHubIssueApiResponse[],
  pulls: GitHubPullApiResponse[],
): GitHubTimelineEvent[] {
  const commitEvents = commits.map((commit) => ({
    author: commit.author?.login ?? commit.commit.author?.name,
    id: `commit-${commit.sha}`,
    type: "commit" as const,
    title: commit.commit.message.split("\n")[0] || commit.sha.slice(0, 7),
    createdAt: githubTimestamp(commit.commit.author?.date),
    status: commit.sha.slice(0, 7),
    url: commit.html_url,
  }));
  const issueEvents = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      author: issue.user?.login,
      id: `issue-${issue.number}`,
      number: issue.number,
      type: "issue" as const,
      title: issue.title,
      createdAt: githubTimestamp(issue.closed_at ?? issue.updated_at),
      status: issue.state,
      url: issue.html_url,
    }));
  const pullEvents = pulls.map((pull) => ({
    author: pull.user?.login,
    id: `pull_request-${pull.number}`,
    number: pull.number,
    type: "pull_request" as const,
    title: pull.title,
    createdAt: githubTimestamp(pull.merged_at ?? pull.closed_at ?? pull.updated_at),
    status: pull.merged_at ? "merged" : pull.state,
    url: pull.html_url,
  }));

  return [...commitEvents, ...issueEvents, ...pullEvents]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 30);
}

// GitHub OAuth device flow 시작은 브라우저 CORS를 피하려고 Tauri 명령을 우선 사용한다.
export async function createGithubDeviceCode() {
  const clientId = getGithubClientId();

  if (!clientId) {
    throw new Error(GITHUB_LOGIN_CONFIG_ERROR_MESSAGE);
  }

  if (!canUseTauriRuntime()) {
    return postGithubOAuthForm<GithubDeviceCodeResponse>(
      "https://github.com/login/device/code",
      {
        client_id: clientId,
        scope: GITHUB_LOGIN_SCOPE,
      },
    );
  }

  return invoke<GithubDeviceCodeResponse>("github_oauth_device_code", {
    clientId,
    scope: GITHUB_LOGIN_SCOPE,
  });
}

// 사용자가 브라우저 인증을 끝냈는지 확인하고 access token을 받는다.
export async function fetchGithubAccessToken(deviceCode: string) {
  const clientId = getGithubClientId();

  if (!clientId) {
    throw new Error(GITHUB_LOGIN_CONFIG_ERROR_MESSAGE);
  }

  if (!canUseTauriRuntime()) {
    return postGithubOAuthForm<GithubAccessTokenResponse>(
      "https://github.com/login/oauth/access_token",
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    );
  }

  return invoke<GithubAccessTokenResponse>("github_oauth_access_token", {
    clientId,
    deviceCode,
  });
}

function getGithubClientId() {
  return GITHUB_CLIENT_ID || localStorage.getItem(GITHUB_CLIENT_ID_STORAGE_KEY)?.trim() || "";
}

async function postGithubOAuthForm<T>(url: string, params: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    throw new Error(`GitHub OAuth ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function getGithubHeaders(accessToken?: string | null) {
  return {
    Accept: "application/vnd.github+json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function fetchGithubJson<T>(path: string, accessToken?: string | null): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: getGithubHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function toGithubOwnerProfile(owner: GitHubOwnerApiResponse | null | undefined) {
  if (!owner?.login) {
    return undefined;
  }

  return {
    login: owner.login,
    avatarUrl: owner.avatar_url ?? "",
    htmlUrl: owner.html_url ?? `https://github.com/${owner.login}`,
    name: null,
  } satisfies GithubUserProfile;
}

function toGithubAvailableRepository(repository: GitHubRepoApiResponse): GithubAvailableRepository {
  return {
    fullName: repository.full_name,
    name: repository.name,
    private: repository.private,
    defaultBranch: repository.default_branch,
    url: repository.html_url,
    owner: toGithubOwnerProfile(repository.owner),
  };
}

async function fetchGithubUserRepositories(accessToken: string) {
  return fetchGithubJson<GitHubUserRepoApiResponse[]>(
    "/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100",
    accessToken,
  );
}

async function fetchGithubInstallationRepositories(accessToken: string) {
  const response = await fetchGithubJson<GitHubInstallationsApiResponse>(
    "/user/installations?per_page=100",
    accessToken,
  );
  const repositoryResponses = await Promise.all(
    response.installations.map((installation) =>
      fetchGithubJson<GitHubInstallationRepositoriesApiResponse>(
        `/user/installations/${installation.id}/repositories?per_page=100`,
        accessToken,
      ),
    ),
  );

  return repositoryResponses.flatMap((repositoryResponse) => repositoryResponse.repositories);
}

export async function fetchGithubRepositories(accessToken: string) {
  const [installationRepositories, userRepositories] = await Promise.all([
    fetchGithubInstallationRepositories(accessToken).catch(() => null),
    fetchGithubUserRepositories(accessToken).catch(() => null),
  ]);
  const repositories = [...(installationRepositories ?? []), ...(userRepositories ?? [])];
  const seenRepositories = new Set<string>();

  if (!installationRepositories && !userRepositories) {
    throw new Error("GitHub repo 목록을 불러올 수 없습니다");
  }

  const visibleRepositories = repositories
    .filter((repository) => {
      if (seenRepositories.has(repository.full_name)) {
        return false;
      }

      seenRepositories.add(repository.full_name);
      return true;
    })
    .map(toGithubAvailableRepository);

  return {
    repositories: visibleRepositories,
    user: visibleRepositories.find((repository) => repository.owner)?.owner,
  };
}

export async function fetchGithubUserProfile(accessToken: string): Promise<GithubUserProfile> {
  const user = await fetchGithubJson<GitHubUserApiResponse>("/user", accessToken);

  return {
    login: user.login,
    avatarUrl: user.avatar_url,
    htmlUrl: user.html_url,
    name: user.name ?? null,
  };
}

export async function createGithubAppSession() {
  return fetchPaimJson<GithubAppSessionApiResponse>("/github/app/sessions", {
    method: "POST",
  });
}

export async function fetchGithubAppSession(state: string) {
  return fetchPaimJson<GithubAppSessionApiResponse>(
    `/github/app/sessions/${encodeURIComponent(state)}`,
  );
}

export async function fetchGithubAppRepositories(state: string) {
  return fetchPaimJson<GithubRepositoriesApiResponse>(
    `/github/app/sessions/${encodeURIComponent(state)}/repositories`,
  );
}

export async function fetchGithubAppRepositoryPreview(repositoryUrl: string, state: string) {
  return fetchPaimJson<GithubRepositoryPreviewApiResponse>("/github/app/repository-preview", {
    method: "POST",
    body: JSON.stringify({ repository_url: repositoryUrl, state }),
  });
}

export async function fetchGithubRepository(rawUrl: string, accessToken?: string | null) {
  const parsedRepo = parseGithubRepositoryUrl(rawUrl);

  if (!parsedRepo) {
    throw new Error("GitHub repository URL을 확인할 수 없습니다");
  }

  const repoPath = `/repos/${parsedRepo.owner}/${parsedRepo.repo}`;
  const repo = await fetchGithubJson<GitHubRepoApiResponse>(repoPath, accessToken);
  const [commits, issues, pulls] = await Promise.all([
    fetchGithubJson<GitHubCommitApiResponse[]>(
      `${repoPath}/commits?sha=${encodeURIComponent(repo.default_branch)}&per_page=24`,
      accessToken,
    ),
    fetchGithubJson<GitHubIssueApiResponse[]>(
      `${repoPath}/issues?state=all&sort=updated&direction=desc&per_page=12`,
      accessToken,
    ),
    fetchGithubJson<GitHubPullApiResponse[]>(
      `${repoPath}/pulls?state=all&sort=updated&direction=desc&per_page=12`,
      accessToken,
    ),
  ]);
  const openIssues = issues.filter((issue) => !issue.pull_request);

  return {
    events: createGithubEvents(commits, issues, pulls),
    repository: {
      path: repo.html_url,
      name: repo.name,
      branch: repo.default_branch,
      isDirty: false,
      remoteRepo: repo.full_name,
      issuePrStatus: `${openIssues.length} open issues · ${pulls.length} open PRs`,
      visibility: repo.private ? "private" as const : "public" as const,
      authProvider: accessToken ? "github_oauth" as const : "public" as const,
    } satisfies GitRepositoryInfo,
  };
}

export function getGithubPanelStateLabel(panelState: GithubPanelState) {
  const labels: Record<GithubPanelState, string> = {
    signedout: "미연결",
    authing: "로그인 중",
    repos: "로그인됨",
    connected: "연결됨",
  };

  return labels[panelState];
}

export function getGithubAvailableRepositoryVisibility(repository: GithubAvailableRepository) {
  return repository.private ? "PRIVATE" : "PUBLIC";
}

export function getGithubRepoLabel(repository: GitRepositoryInfo) {
  const visibility = repository.visibility === "private" ? "Private" : "Public";
  const provider =
    repository.authProvider === "github_oauth"
      ? "GitHub Login"
      : repository.authProvider === "github_app"
        ? "GitHub App"
        : "Public API";

  return `${visibility} · ${provider}`;
}
