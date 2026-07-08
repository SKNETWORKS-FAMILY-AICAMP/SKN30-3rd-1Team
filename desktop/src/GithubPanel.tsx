import { Check, Copy, GitBranch, Link2, LogOut, MoreHorizontal, RefreshCcw, Search, X } from "lucide-react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
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
import { useI18n } from "./i18n";
import type { LanguageSetting } from "./settings";
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

function getGithubEventMeta(event: GitHubTimelineEvent, language: LanguageSetting) {
  const items = [];

  if (event.status) {
    items.push(event.type === "commit" ? event.status : event.status.toUpperCase());
  }

  if (event.author) {
    items.push(event.author);
  }

  items.push(formatRelativeAge(event.createdAt, language));

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

function getGithubEventBadgeVariant(event: GitHubTimelineEvent): BadgeVariant {
  if (event.type === "pull_request") {
    if (event.status === "merged") {
      return "green";
    }

    if (event.status === "closed") {
      return "red";
    }

    return "purple";
  }

  if (event.type === "issue") {
    return event.status === "closed" ? "green" : "yellow";
  }

  return "neutral";
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

function formatSyncElapsed(seconds: number, language: LanguageSetting) {
  if (seconds < 60) {
    return language === "en" ? `${seconds}s` : `${seconds}초`;
  }

  return language === "en"
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
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

function getGithubPanelStateBadgeVariant(panelState: GithubPanelState) {
  if (panelState === "authing") {
    return "blue";
  }

  if (panelState === "repos" || panelState === "connected") {
    return "green";
  }

  return "neutral";
}

function getGithubRepositorySyncBadgeVariant(repository: GitRepositoryInfo) {
  if (repository.syncStatus === "indexed") {
    return "success";
  }

  if (repository.syncStatus === "syncing" || repository.syncStatus === "delayed") {
    return "warning";
  }

  if (repository.syncStatus === "failed") {
    return "error";
  }

  return "neutral";
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
  const { language, t } = useI18n();
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
        <Badge
          className="overview-github-state"
          label={t(getGithubPanelStateLabel(panelState))}
          variant={getGithubPanelStateBadgeVariant(panelState)}
        />
      </div>
      {demoStatus?.scope === "github" ? (
        <Banner
          className="runtime-status overview-github-status"
          container="card"
          key={statusRevision}
          status={demoStatus.ok ? "info" : "error"}
          title={t(demoStatus.message)}
        />
      ) : null}

      {panelState === "signedout" ? (
        <Card
          className="overview-github-card overview-github-login-card"
          padding={0}
          variant="transparent"
        >
          <div className="overview-github-login-intro">
            <span className="overview-github-logo-box" data-size="large" aria-hidden="true">
              <img className="overview-github-logo" src={githubMark} alt="" />
            </span>
            <p>{t("GitHub 연결")}</p>
            <small>{t("로그인하면 repo의 활동이 이 탭에 실시간으로 쌓입니다.")}</small>
          </div>
          <Button
            className="overview-github-primary-button"
            icon={<img className="overview-github-button-logo" src={githubMark} alt="" />}
            isDisabled={isAuthStarting}
            label={isAuthStarting ? t("여는 중...") : t("GitHub 로그인")}
            onClick={onStartLogin}
            variant="primary"
          />
          <div className="overview-github-private-guide">
            <Button
              className="overview-github-ghost-button"
              icon={<GitBranch size={14} />}
              isDisabled={isAuthStarting}
              label={t("Private repo 연결")}
              onClick={onStartPrivateLogin}
              variant="ghost"
            />
            <p>{t("Private repo는 GitHub App 설치가 필요해요")}</p>
          </div>
          <Divider className="overview-github-private-divider" />
          <p className="overview-github-list-label">{t("연결하면 볼 수 있어요")}</p>
          <div className="overview-github-feature-list" aria-label={t("GitHub 연결 후 볼 수 있는 정보")}>
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
                  <p>{t(feature.title)}</p>
                  <small>{t(feature.description)}</small>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {panelState === "authing" ? (
        <Card
          className="overview-github-card overview-github-auth-card"
          padding={0}
          variant="transparent"
        >
          <span className="overview-github-logo-box" aria-hidden="true">
            <img className="overview-github-logo" src={githubMark} alt="" />
          </span>
          <p>{t("브라우저에서 GitHub 연결을 완료해 주세요")}</p>
          <small>
            {session?.userCode
              ? t("GitHub 인증 페이지에서 아래 코드를 입력한 뒤 완료 버튼을 눌러 주세요.")
              : t("GitHub App 설치 화면에서 접근할 repo를 선택한 뒤 완료 버튼을 눌러 주세요.")}
          </small>
          {session?.userCode ? (
            <>
              <span className="overview-github-code">{session.userCode}</span>
              <Button
                className="overview-github-ghost-button overview-github-code-copy"
                icon={<Copy size={14} />}
                label={t("코드 복사")}
                onClick={handleCopyGithubCode}
                variant="ghost"
              />
            </>
          ) : null}
          <Spinner
            className="overview-github-loader"
            label={session?.userCode ? t("로그인 대기 중...") : t("설치 대기 중...")}
            shade="subtle"
          />
          <div className="overview-github-action-buttons">
            <Button
              className="overview-github-ghost-button"
              icon={<Link2 size={14} />}
              label={session?.userCode ? t("브라우저 열기") : t("설치 화면 열기")}
              onClick={onOpenVerification}
              variant="ghost"
            />
            <Button
              className="overview-github-secondary-button"
              icon={<Check size={14} />}
              isDisabled={isAuthChecking}
              label={
                isAuthChecking
                  ? t("확인 중...")
                  : session?.userCode
                    ? t("로그인 완료했어요")
                    : t("설치 완료했어요")
              }
              onClick={onCheckLogin}
              variant="secondary"
            />
            <Button
              className="overview-github-ghost-button"
              icon={<X size={14} />}
              label={t("취소")}
              onClick={onResetLogin}
              variant="ghost"
            />
          </div>
        </Card>
      ) : null}

      {panelState === "repos" ? (
        <Card
          className="overview-github-card overview-github-repos-card"
          padding={0}
          variant="transparent"
        >
          <div className="overview-github-toolbar">
            <div className="overview-github-account">
              <Avatar
                alt={githubUser?.login ?? "GitHub"}
                name={githubUser?.login ?? "GitHub"}
                size={24}
                src={githubUser?.avatarUrl}
              />
              <span>{githubUser?.login ?? "GitHub"}</span>
            </div>
            <Button
              className="overview-github-ghost-button"
              icon={<LogOut size={13} />}
              label={t("로그아웃")}
              onClick={onResetLogin}
              size="sm"
              variant="ghost"
            />
          </div>
          <TextInput
            className="overview-github-search"
            hasClear
            isLabelHidden
            label={t("GitHub repo 검색")}
            onChange={onQueryChange}
            placeholder={t("repo 검색...")}
            startIcon={<Search size={15} />}
            value={repositoryQuery}
            width="100%"
          />
          {!session?.state ? (
            <div className="overview-github-private-guide" data-compact="true">
              <p>{t("Private repo는 GitHub App 설치 후 볼 수 있어요")}</p>
              <Button
                className="overview-github-ghost-button"
                icon={<GitBranch size={14} />}
                isDisabled={isAuthStarting}
                label={t("Private repo 연결")}
                onClick={onStartPrivateLogin}
                size="sm"
                variant="ghost"
              />
            </div>
          ) : null}
          <p className="overview-github-list-label">
            YOUR REPOS · {filteredRepositories.length}
          </p>
          {repositories.length > 0 ? (
            <div className="overview-github-repo-list" aria-label={t("접근 가능한 GitHub repo")}>
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
                        <Badge
                          className="overview-github-repo-visibility"
                          label={getGithubAvailableRepositoryVisibility(availableRepository)}
                          variant={availableRepository.private ? "purple" : "blue"}
                        />
                      </div>
                      <small>{t("기본 브랜치 {branch}", { branch: availableRepository.defaultBranch })}</small>
                    </div>
                    <Button
                      className="overview-github-secondary-button"
                      icon={<Link2 size={14} />}
                      isDisabled={isConnecting}
                      label={isConnecting ? t("연결 중...") : t("연결")}
                      onClick={() => onConnectRepository(availableRepository.url)}
                      size="sm"
                      variant="secondary"
                    />
                  </div>
                ))
              ) : (
                <EmptyState
                  className="overview-github-empty"
                  icon={<Search size={17} />}
                  isCompact
                  title={t("\"{query}\" 검색 결과가 없습니다", { query: repositoryQuery })}
                />
              )}
            </div>
          ) : (
            <EmptyState
              actions={
                <Button
                  className="overview-github-secondary-button"
                  icon={<RefreshCcw size={14} />}
                  isDisabled={isRepoLoading}
                  label={isRepoLoading ? t("불러오는 중...") : t("Repo 목록 불러오기")}
                  onClick={onLoadRepositories}
                  variant="secondary"
                />
              }
              className="overview-github-empty"
              isCompact
              title={t("아직 불러온 repo가 없습니다.")}
            />
          )}
        </Card>
      ) : null}

      {repository ? (
        <Card className="overview-github-card overview-github-connected-card" padding={3}>
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
                  <Badge
                    className="overview-github-repo-visibility"
                    label={repository.visibility === "private" ? "PRIVATE" : "PUBLIC"}
                    variant={repository.visibility === "private" ? "purple" : "blue"}
                  />
                </div>
                <p className="overview-github-meta">
                  {getGithubRepoOwner(repository)} · {repository.branch}
                </p>
              </div>
              <DropdownMenu
                button={{
                  className: "overview-github-more-menu",
                  icon: <MoreHorizontal size={15} />,
                  isIconOnly: true,
                  label: t("repo 작업"),
                  size: "sm",
                  tooltip: t("repo 작업"),
                  variant: "ghost",
                }}
                items={[
                  {
                    icon: <GitBranch size={13} />,
                    label: isDisconnectConfirming ? t("변경 확인") : t("repo 변경"),
                    onClick: () => onDisconnect(t("repo 연결을 해제했습니다. 새 repo를 선택하세요")),
                  },
                  {
                    icon: <X size={13} />,
                    label: isDisconnectConfirming ? t("해제 확인") : t("연결 해제"),
                    onClick: () => onDisconnect(),
                  },
                ]}
                menuWidth={132}
              />
            </div>
            <div className="overview-github-stat-strip">
              <span data-type="commit">
                <strong>{eventCounts.commit}</strong>
                {t("커밋")}
              </span>
              <Divider className="overview-github-stat-divider" orientation="vertical" />
              <span data-type="pull_request">
                <strong>{eventCounts.pull_request}</strong>
                PR
              </span>
              <Divider className="overview-github-stat-divider" orientation="vertical" />
              <span data-type="issue">
                <strong>{eventCounts.issue}</strong>
                {t("이슈")}
              </span>
              <IconButton
                className="overview-github-sync-button"
                icon={<RefreshCcw size={15} />}
                isDisabled={isSyncing || isRepositorySyncing}
                label={t("GitHub 동기화")}
                onClick={onSyncRepository}
                size="sm"
                tooltip={isRepositorySyncing ? t("동기화 중") : t("GitHub 동기화")}
                variant="ghost"
              />
            </div>
            <div
              className="overview-github-sync-state"
              data-status={repository.syncStatus ?? "connected"}
            >
              <Badge
                label={t(getGithubRepositorySyncLabel(repository))}
                variant={getGithubRepositorySyncBadgeVariant(repository)}
              />
              {repository.syncStatus === "syncing" ? (
                <Spinner
                  aria-label={t("GitHub 동기화 중")}
                  className="overview-github-sync-progress"
                  label={
                  <div>
                    <p>{t("커밋·이슈·PR 수집·분석 중")}</p>
                    <small>{t("{elapsed} 경과", { elapsed: formatSyncElapsed(syncElapsedSeconds, language) })}</small>
                  </div>
                  }
                  shade="subtle"
                />
              ) : null}
              {repository.syncStatus === "indexed" ? (
                <small>
                  {repository.indexedFiles ?? 0} files
                  {repository.commitSha ? ` · ${repository.commitSha.slice(0, 7)}` : ""}
                </small>
              ) : null}
              {repository.syncStatus === "failed" || repository.syncStatus === "delayed" ? (
                <>
                  <small>{repository.lastError ?? t("GitHub repo 동기화 실패")}</small>
                  <Button
                    icon={<RefreshCcw size={13} />}
                    isDisabled={isSyncing}
                    label={isSyncing ? t("재시도 중...") : t("재시도")}
                    onClick={onSyncRepository}
                    size="sm"
                    variant="secondary"
                  />
                </>
              ) : null}
              {getGithubRepositoryWarningLabel(repository) ? (
                <small className="overview-github-sync-warning">
                  {t(getGithubRepositoryWarningLabel(repository) ?? "")}
                </small>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {events.length > 0 ? (
        <>
          <p className="overview-github-list-label">{t("타임라인")}</p>
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
                    <Badge
                      className="overview-timeline-label"
                      data-event-type={event.type}
                      data-status={event.status ?? ""}
                      label={getGithubEventLabel(event)}
                      variant={getGithubEventBadgeVariant(event)}
                    />
                    <p>{event.title}</p>
                  </div>
                  <small>
                    {getGithubEventMeta(event, language).map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : githubConnected ? (
        <EmptyState
          className="overview-empty-text"
          icon={<SvgIcon svg={tablerAlertCircle} />}
          isCompact
          title={t("아직 GitHub 이벤트가 없습니다.")}
        />
      ) : null}
    </div>
  );
}
