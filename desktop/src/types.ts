export type Attachment = {
  id: string;
  name: string;
  path: string;
  kind?: "file" | "directory";
  children?: Attachment[];
  childrenLoaded?: boolean;
  isExpanded?: boolean;
  uploadedAt?: number;
  previewUrl?: string;
};

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
  role: "assistant" | "user";
  content: string;
  attachments?: Attachment[];
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
};

export type ProjectWorkspace = {
  id: string;
  name: string;
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
