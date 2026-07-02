export type Attachment = {
  id: string;
  name: string;
  path: string;
  kind?: "file" | "directory";
  children?: Attachment[];
  childrenLoaded?: boolean;
  docId?: number;
  documentStatus?: ProjectDocumentStatus;
  isExpanded?: boolean;
  lastError?: string | null;
  serverOnly?: boolean;
  uploadedAt?: number;
  previewUrl?: string;
};

export type ProjectDocumentStatus =
  | "uploading"
  | "uploaded"
  | "processing"
  | "indexed"
  | "failed"
  | "delayed";

export type DirectoryChildEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};

export type ProjectFilePreview = {
  id: string;
  name: string;
  path: string;
  content: string;
  isLoading: boolean;
  error?: string;
};

export type Message = {
  id: string;
  role: "assistant" | "error" | "user";
  content: string;
  attachments?: Attachment[];
  sources?: string[];
};

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
};

export type GitHubEventType = "issue" | "pull_request" | "commit";

export type GitHubTimelineEvent = {
  author?: string;
  id: string;
  number?: number;
  type: GitHubEventType;
  title: string;
  createdAt: number;
  status?: string;
  url?: string;
};

export type GitRepositoryInfo = {
  path: string;
  name: string;
  branch: string;
  isDirty: boolean;
  remoteRepo?: string;
  issuePrStatus: string;
  visibility?: "public" | "private";
  authProvider?: "public" | "github_oauth" | "github_app";
  repoId?: number;
  syncStatus?: GitRepositorySyncStatus;
  connectedAt?: string;
  commitSha?: string | null;
  indexedFiles?: number | null;
  lastError?: string | null;
  syncWarnings?: GitRepositorySyncWarning[];
};

export type GitRepositorySyncStatus = "connected" | "syncing" | "indexed" | "failed" | "delayed";

export type GitRepositorySyncWarning = {
  source_type?: string;
  reason?: string;
};

export type ProjectMemoryCategory = "decision" | "action" | "issue" | "risk";

export type ProjectMemoryItem = {
  id: number;
  project_id?: number;
  doc_id?: number;
  category: ProjectMemoryCategory;
  content: string;
  reason?: string | null;
  topic?: string | null;
  owner?: string | null;
  date?: string | null;
  source?: string | null;
  created_at?: string | null;
};

export type ProjectWorkspace = {
  id: string;
  apiProjectId?: number;
  serverMissing?: boolean;
  name: string;
  description?: string;
  files?: Attachment[];
  githubConnected?: boolean;
  githubRepository?: GitRepositoryInfo;
  githubEvents?: GitHubTimelineEvent[];
  sessions: ChatSession[];
  createdAt: number;
};

export type ProjectState = {
  projects: ProjectWorkspace[];
  selectedProjectId: string | null;
  selectedSessionId: string | null;
};

export type DemoStatus = {
  ok: boolean;
  message: string;
  scope?: "github" | "overview";
};

export type GithubLoginSessionState = {
  deviceCode?: string;
  state?: string;
  userCode?: string;
  verificationUri: string;
  interval: number;
  status: "pending" | "connected";
  accessToken?: string;
  scope?: string;
  tokenType?: string;
  user?: GithubUserProfile;
};

export type GithubUserProfile = {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  name?: string | null;
};

export type GithubDeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
};

export type GithubAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type GithubAvailableRepository = {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  owner?: GithubUserProfile;
};

export type GithubPanelState = "signedout" | "authing" | "repos" | "connected";
export type ProjectSourcesMode = "library" | "tree";
