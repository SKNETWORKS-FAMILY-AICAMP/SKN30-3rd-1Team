import { Check, Copy, GitBranch, Link2, LogOut, MoreHorizontal, RefreshCcw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import githubMark from "../assets/github/github-mark.svg";
import tablerAlertCircle from "./assets/tabler-icons/alert-circle.svg?raw";
import tablerGitCommit from "./assets/tabler-icons/git-commit.svg?raw";
import tablerGitPullRequest from "./assets/tabler-icons/git-pull-request.svg?raw";
import { formatRelativeAge } from "./format";
import {
  getGithubAvailableRepositoryVisibility,
  getGithubPanelStateLabel,
} from "./github";
import type {
  DemoStatus,
  GithubAvailableRepository,
  GithubLoginSessionState,
  GithubPanelState,
  GitHubEventType,
  GitHubTimelineEvent,
  GitRepositoryInfo,
} from "./types";

type SvgIconProps = {
  className?: string;
  label?: string;
  svg: string;
};

type GithubPanelProps = {
  demoStatus: DemoStatus | null;
  events: GitHubTimelineEvent[];
  filteredRepositories: GithubAvailableRepository[];
  githubConnected?: boolean;
  isAuthChecking: boolean;
  isAuthStarting: boolean;
  isConnecting: boolean;
  isDisconnectConfirming: boolean;
  isRepoLoading: boolean;
  isSyncing: boolean;
  onCheckLogin: () => void;
  onConnectRepository: (repositoryUrl: string) => void;
  onDisconnect: (message?: string) => void;
  onLoadRepositories: () => void;
  onOpenVerification: () => void;
  onQueryChange: (query: string) => void;
  onResetLogin: () => void;
  onStartLogin: () => void;
  onStartPrivateLogin: () => void;
  onSyncRepository: () => void;
  panelState: GithubPanelState;
  repositories: GithubAvailableRepository[];
  repository?: GitRepositoryInfo;
  repositoryQuery: string;
  session: GithubLoginSessionState | null;
  statusRevision: number;
};

const githubFeatureCards = [
  {
    description: "최근 푸시·머지 이력",
    icon: tablerGitCommit,
    title: "커밋 타임라인",
    tone: "commit",
  },
  {
    description: "열린 작업 현황",
    icon: tablerGitPullRequest,
    title: "PR · 이슈",
    tone: "pull_request",
  },
  {
    description: "이슈와 리스크 연결",
    icon: tablerAlertCircle,
    title: "메모리 연동",
    tone: "issue",
  },
] as const;

function SvgIcon({ className = "", label, svg }: SvgIconProps) {
  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={`tabler-icon ${className}`.trim()}
      role={label ? "img" : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function getGithubEventIconSvg(eventType: GitHubEventType) {
  if (eventType === "pull_request") {
    return tablerGitPullRequest;
  }

  if (eventType === "commit") {
    return tablerGitCommit;
  }

  return tablerAlertCircle;
}

function getGithubEventMeta(event: GitHubTimelineEvent) {
  const items = [];

  if (event.status) {
    items.push(event.type === "commit" ? event.status : event.status.toUpperCase());
  }

  if (event.author) {
    items.push(event.author);
  }

  items.push(formatRelativeAge(event.createdAt));

  return items;
}

function getGithubEventLabel(event: GitHubTimelineEvent) {
  if (event.type === "pull_request") {
    return event.number ? `PR #${event.number}` : "PR";
  }

  if (event.type === "issue") {
    return event.number ? `ISSUE #${event.number}` : "ISSUE";
  }

  return "COMMIT";
}

function getGithubRepoShortName(repository: GitRepositoryInfo) {
  return (repository.remoteRepo ?? repository.name).split("/").pop() ?? repository.name;
}

function getGithubRepoOwner(repository: GitRepositoryInfo) {
  const [owner] = (repository.remoteRepo ?? "").split("/");

  return owner || "GitHub";
}

// 연결된 repo 이벤트를 카드 안의 요약 숫자로 압축한다.
function getGithubEventCounts(events: GitHubTimelineEvent[]) {
  const counts = { commit: 0, issue: 0, pull_request: 0 };

  events.forEach((event) => {
    if (
      (event.type === "pull_request" || event.type === "issue") &&
      event.status !== "open"
    ) {
      return;
    }

    counts[event.type] += 1;
  });

  return counts;
}

function getGithubRepositorySyncLabel(repository: GitRepositoryInfo) {
  if (repository.syncStatus === "syncing") {
    return "진행 중";
  }

  if (repository.syncStatus === "indexed") {
    return "완료";
  }

  if (repository.syncStatus === "failed") {
    return "실패";
  }

  if (repository.syncStatus === "delayed") {
    return "처리 지연";
  }

  return "서버 연결됨";
}

function formatSyncElapsed(seconds: number) {
  if (seconds < 60) {
    return `${seconds}초`;
  }

  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

function getGithubRepositoryWarningLabel(repository: GitRepositoryInfo) {
  const warning = repository.syncWarnings?.[0];

  if (!warning) {
    return null;
  }

  return warning.source_type && warning.reason
    ? `${warning.source_type} 수집 실패: ${warning.reason}`
    : "일부 소스 수집 실패";
}

// 우측 패널의 GitHub 로그인, repo 선택, 이벤트 타임라인 화면을 렌더링한다.
export function GithubPanel({
  demoStatus,
  events,
  filteredRepositories,
  githubConnected,
  isAuthChecking,
  isAuthStarting,
  isConnecting,
  isDisconnectConfirming,
  isRepoLoading,
  isSyncing,
  onCheckLogin,
  onConnectRepository,
  onDisconnect,
  onLoadRepositories,
  onOpenVerification,
  onQueryChange,
  onResetLogin,
  onStartLogin,
  onStartPrivateLogin,
  onSyncRepository,
  panelState,
  repositories,
  repository,
  repositoryQuery,
  session,
  statusRevision,
}: GithubPanelProps) {
  const eventCounts = getGithubEventCounts(events);
  const isRepositorySyncing = repository?.syncStatus === "syncing";
  const [syncElapsedSeconds, setSyncElapsedSeconds] = useState(0);
  const githubUser =
    session?.user ?? repositories.find((availableRepository) => availableRepository.owner)?.owner;

  useEffect(() => {
    if (!isRepositorySyncing) {
      setSyncElapsedSeconds(0);
      return;
    }

    const startedAt = repository?.syncStartedAt ?? Date.now();
    const updateElapsed = () => {
      setSyncElapsedSeconds(Math.floor(Math.max(0, Date.now() - startedAt) / 1000));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);

    return () => window.clearInterval(intervalId);
  }, [isRepositorySyncing, repository?.syncStartedAt]);

  function handleCopyGithubCode() {
    if (!session?.userCode) {
      return;
    }

    void navigator.clipboard.writeText(session.userCode);
  }

  return (
    <div className="project-panel-content github-panel-content" data-state={panelState}>
      <div className="overview-github-header">
        <span className="overview-github-state" data-state={panelState}>
          {getGithubPanelStateLabel(panelState)}
        </span>
      </div>
      {demoStatus?.scope === "github" ? (
        <p
          className="notice runtime-status overview-github-status"
          data-kind={demoStatus.ok ? "info" : "error"}
          key={statusRevision}
          role="status"
        >
          <i aria-hidden="true" />
          <span>{demoStatus.message}</span>
        </p>
      ) : null}

      {panelState === "signedout" ? (
        <div className="overview-github-card overview-github-login-card">
          <div className="overview-github-login-intro">
            <span className="overview-github-logo-box" data-size="large" aria-hidden="true">
              <img className="overview-github-logo" src={githubMark} alt="" />
            </span>
            <p>GitHub 연결</p>
            <small>로그인하면 repo의 활동이 이 탭에 실시간으로 쌓입니다.</small>
          </div>
          <button
            className="overview-github-primary-button"
            disabled={isAuthStarting}
            onClick={onStartLogin}
            type="button"
          >
            <img className="overview-github-button-logo" src={githubMark} alt="" />
            <span>{isAuthStarting ? "여는 중..." : "GitHub 로그인"}</span>
          </button>
          <div className="overview-github-private-guide">
            <button
              className="overview-github-ghost-button"
              disabled={isAuthStarting}
              onClick={onStartPrivateLogin}
              type="button"
            >
              <GitBranch size={14} />
              <span>Private repo 연결</span>
            </button>
            <p>Private repo는 GitHub App 설치가 필요해요</p>
          </div>
          <p className="overview-github-list-label">연결하면 볼 수 있어요</p>
          <div className="overview-github-feature-list" aria-label="GitHub 연결 후 볼 수 있는 정보">
            {githubFeatureCards.map((feature) => (
              <div
                className="overview-github-feature-row"
                data-tone={feature.tone}
                key={feature.title}
              >
                <span className="overview-github-feature-icon" aria-hidden="true">
                  <SvgIcon svg={feature.icon} />
                </span>
                <div>
                  <p>{feature.title}</p>
                  <small>{feature.description}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {panelState === "authing" ? (
        <div className="overview-github-card overview-github-auth-card">
          <span className="overview-github-logo-box" aria-hidden="true">
            <img className="overview-github-logo" src={githubMark} alt="" />
          </span>
          <p>브라우저에서 GitHub 연결을 완료해 주세요</p>
          <small>
            {session?.userCode
              ? "GitHub 인증 페이지에서 아래 코드를 입력한 뒤 완료 버튼을 눌러 주세요."
              : "GitHub App 설치 화면에서 접근할 repo를 선택한 뒤 완료 버튼을 눌러 주세요."}
          </small>
          {session?.userCode ? (
            <>
              <span className="overview-github-code">{session.userCode}</span>
              <button
                className="overview-github-ghost-button overview-github-code-copy"
                onClick={handleCopyGithubCode}
                type="button"
              >
                <Copy size={14} />
                <span>코드 복사</span>
              </button>
            </>
          ) : null}
          <span className="overview-github-loader">
            <RefreshCcw size={16} />
            {session?.userCode ? "로그인 대기 중..." : "설치 대기 중..."}
          </span>
          <div className="overview-github-action-buttons">
            <button
              className="overview-github-ghost-button"
              onClick={onOpenVerification}
              type="button"
            >
              <Link2 size={14} />
              <span>{session?.userCode ? "브라우저 열기" : "설치 화면 열기"}</span>
            </button>
            <button
              className="overview-github-secondary-button"
              disabled={isAuthChecking}
              onClick={onCheckLogin}
              type="button"
            >
              <Check size={14} />
              <span>
                {isAuthChecking ? "확인 중..." : session?.userCode ? "로그인 완료했어요" : "설치 완료했어요"}
              </span>
            </button>
            <button className="overview-github-ghost-button" onClick={onResetLogin} type="button">
              <X size={14} />
              <span>취소</span>
            </button>
          </div>
        </div>
      ) : null}

      {panelState === "repos" ? (
        <div className="overview-github-card overview-github-repos-card">
          <div className="overview-github-toolbar">
            <div className="overview-github-account">
              {githubUser?.avatarUrl ? (
                <img className="overview-github-user-avatar" src={githubUser.avatarUrl} alt="" />
              ) : (
                <span className="overview-github-user-avatar">
                  {githubUser?.login?.charAt(0).toUpperCase() ?? "?"}
                </span>
              )}
              <span>{githubUser?.login ?? "GitHub"}</span>
            </div>
            <button className="overview-github-ghost-button" onClick={onResetLogin} type="button">
              <LogOut size={13} />
              <span>로그아웃</span>
            </button>
          </div>
          <label className="overview-github-search">
            <Search size={15} />
            <input
              aria-label="GitHub repo 검색"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="repo 검색..."
              type="text"
              value={repositoryQuery}
            />
            {repositoryQuery ? (
              <button
                aria-label="repo 검색어 지우기"
                onClick={() => onQueryChange("")}
                title="repo 검색어 지우기"
                type="button"
              >
                <X size={15} />
              </button>
            ) : null}
          </label>
          {!session?.state ? (
            <div className="overview-github-private-guide" data-compact="true">
              <p>Private repo는 GitHub App 설치 후 볼 수 있어요</p>
              <button
                className="overview-github-ghost-button"
                disabled={isAuthStarting}
                onClick={onStartPrivateLogin}
                type="button"
              >
                <GitBranch size={14} />
                <span>Private repo 연결</span>
              </button>
            </div>
          ) : null}
          <p className="overview-github-list-label">
            YOUR REPOS · {filteredRepositories.length}
          </p>
          {repositories.length > 0 ? (
            <div className="overview-github-repo-list" aria-label="접근 가능한 GitHub repo">
              {filteredRepositories.length > 0 ? (
                filteredRepositories.map((availableRepository, index) => (
                  <div
                    className="overview-github-repo-row"
                    data-last={index === filteredRepositories.length - 1}
                    key={availableRepository.fullName}
                  >
                    <GitBranch size={16} />
                    <div className="overview-github-repo-copy">
                      <div>
                        <p>{availableRepository.fullName}</p>
                        <span
                          className="overview-github-repo-visibility"
                          data-visibility={availableRepository.private ? "private" : "public"}
                        >
                          {getGithubAvailableRepositoryVisibility(availableRepository)}
                        </span>
                      </div>
                      <small>기본 브랜치 {availableRepository.defaultBranch}</small>
                    </div>
                    <button
                      className="overview-github-secondary-button"
                      disabled={isConnecting}
                      onClick={() => onConnectRepository(availableRepository.url)}
                      type="button"
                    >
                      <Link2 size={14} />
                      <span>{isConnecting ? "연결 중..." : "연결"}</span>
                    </button>
                  </div>
                ))
              ) : (
                <p className="overview-github-empty">"{repositoryQuery}" 검색 결과가 없습니다</p>
              )}
            </div>
          ) : (
            <div className="overview-github-empty">
              <p>아직 불러온 repo가 없습니다.</p>
              <button
                className="overview-github-secondary-button"
                disabled={isRepoLoading}
                onClick={onLoadRepositories}
                type="button"
              >
                <RefreshCcw size={14} />
                <span>{isRepoLoading ? "불러오는 중..." : "Repo 목록 불러오기"}</span>
              </button>
            </div>
          )}
        </div>
      ) : null}

      {repository ? (
        <div className="overview-github-card overview-github-connected-card">
          <div className="overview-github-connected-header">
            <div className="overview-github-brand">
              <span className="overview-github-logo-box" data-tone="connected" aria-hidden="true">
                <img className="overview-github-logo" src={githubMark} alt="" />
              </span>
              <div className="overview-github-copy">
                <div className="overview-github-repo-title">
                  <p className="overview-github-repo-name">
                    {getGithubRepoShortName(repository)}
                  </p>
                  <span
                    className="overview-github-repo-visibility"
                    data-visibility={repository.visibility ?? "public"}
                  >
                    {repository.visibility === "private" ? "PRIVATE" : "PUBLIC"}
                  </span>
                </div>
                <p className="overview-github-meta">
                  {getGithubRepoOwner(repository)} · {repository.branch}
                </p>
              </div>
              <details className="overview-github-more-menu">
                <summary aria-label="repo 작업" title="repo 작업">
                  <MoreHorizontal size={15} />
                </summary>
                <div>
                  <button
                    onClick={() => onDisconnect("repo 연결을 해제했습니다. 새 repo를 선택하세요")}
                    type="button"
                  >
                    <GitBranch size={13} />
                    <span>{isDisconnectConfirming ? "변경 확인" : "repo 변경"}</span>
                  </button>
                  <button onClick={() => onDisconnect()} type="button">
                    <X size={13} />
                    <span>{isDisconnectConfirming ? "해제 확인" : "연결 해제"}</span>
                  </button>
                </div>
              </details>
            </div>
            <div className="overview-github-stat-strip">
              <span data-type="commit">
                <strong>{eventCounts.commit}</strong>
                커밋
              </span>
              <i aria-hidden="true" />
              <span data-type="pull_request">
                <strong>{eventCounts.pull_request}</strong>
                PR
              </span>
              <i aria-hidden="true" />
              <span data-type="issue">
                <strong>{eventCounts.issue}</strong>
                이슈
              </span>
              <button
                aria-label="GitHub 동기화"
                className="overview-github-sync-button"
                disabled={isSyncing || isRepositorySyncing}
                onClick={onSyncRepository}
                title={isRepositorySyncing ? "동기화 중" : "GitHub 동기화"}
                type="button"
              >
                <RefreshCcw size={15} />
              </button>
            </div>
            <div
              className="overview-github-sync-state"
              data-status={repository.syncStatus ?? "connected"}
            >
              <span>{getGithubRepositorySyncLabel(repository)}</span>
              {repository.syncStatus === "syncing" ? (
                <div className="overview-github-sync-progress" role="status">
                  <RefreshCcw size={14} />
                  <div>
                    <p>커밋·이슈·PR 수집·분석 중</p>
                    <small>{formatSyncElapsed(syncElapsedSeconds)} 경과</small>
                  </div>
                </div>
              ) : null}
              {repository.syncStatus === "indexed" ? (
                <small>
                  {repository.indexedFiles ?? 0} files
                  {repository.commitSha ? ` · ${repository.commitSha.slice(0, 7)}` : ""}
                </small>
              ) : null}
              {repository.syncStatus === "failed" || repository.syncStatus === "delayed" ? (
                <>
                  <small>{repository.lastError ?? "GitHub repo 동기화 실패"}</small>
                  <button disabled={isSyncing} onClick={onSyncRepository} type="button">
                    <RefreshCcw size={13} />
                    <span>{isSyncing ? "재시도 중..." : "재시도"}</span>
                  </button>
                </>
              ) : null}
              {getGithubRepositoryWarningLabel(repository) ? (
                <small className="overview-github-sync-warning">
                  {getGithubRepositoryWarningLabel(repository)}
                </small>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {events.length > 0 ? (
        <>
          <p className="overview-github-list-label">타임라인</p>
          <div className="overview-timeline-list">
            {events.map((event, index) => (
              <div className="overview-timeline-row" key={event.id}>
                <div
                  className="overview-timeline-icon"
                  data-event-type={event.type}
                  data-status={event.status ?? ""}
                >
                  <SvgIcon svg={getGithubEventIconSvg(event.type)} />
                  {index < events.length - 1 ? <span /> : null}
                </div>
                <div className="overview-timeline-copy">
                  <div className="overview-timeline-title-row">
                    <span
                      className="overview-timeline-label"
                      data-event-type={event.type}
                      data-status={event.status ?? ""}
                    >
                      {getGithubEventLabel(event)}
                    </span>
                    <p>{event.title}</p>
                  </div>
                  <small>
                    {getGithubEventMeta(event).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : githubConnected ? (
        <p className="overview-empty-text">
          <SvgIcon svg={tablerAlertCircle} />
          아직 GitHub 이벤트가 없습니다.
        </p>
      ) : null}
    </div>
  );
}
