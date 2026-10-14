export type User = {
  id: string;
  email: string | null;
  displayName: string;
  marketId: string | null;
  preferredLanguage: string;
  timezone: string;
  // Also returned by GET /me
  phone?: string | null;
  secondaryLanguages?: string[] | null;
  autoTranslate?: boolean | null;
  showOriginalByDefault?: boolean | null;
  status?: string;
};

export type RequestRow = { id: string; rawText: string | null; status: string; createdAt: string };

export type ProjectRow = {
  id: string; title: string; status: string; health: string; currency: string; createdAt: string; roles: string[];
  taskStatuses: Record<string, number>;
};

export type Market = { id: string; code: string; name: string; defaultCurrency: string; currencies: string[] };

export type Task = { id: string; title: string; description: string | null; status: string; stageId: string | null };
export type Stage = { id: string; name: string; status: string };

export type ProjectDetail = {
  project: { id: string; title: string; objective: string | null; status: string; health: string; currency: string; timezone: string };
  roles: string[];
  stages: Stage[];
  tasks: Task[];
};

// GET /providers?q=  (directory)
export type ProviderRow = { id: string; displayName: string; headline: string | null; kind: string; remoteOk: boolean; categories?: string[] };

// GET /providers/me
export type ProviderProfile = {
  id: string; userId: string; kind: string; displayName: string; headline: string | null; bio: string | null;
  remoteOk: boolean; isActive: boolean; createdAt: string;
};

// GET /providers/me/invitations
export type Invitation = {
  taskId: string; taskTitle: string; taskDescription: string | null; taskStatus: string;
  projectTitle: string; projectCurrency: string; projectTimezone: string;
  status: string; invitedAt: string; quoteId: string | null; quoteStatus: string | null;
};

// GET /assignments
export type AssignmentRow = {
  id: string; status: string; offeredAt: string; agreedTotalMinor: number | null; agreedCurrency: string | null;
  task: { id: string; title: string; status: string };
  project: { id: string; title: string; currency: string; timezone: string };
};

// GET /providers/me/payout-account
export type PayoutAccount = { bankCode: string; accountLast4: string; accountName: string; currency: string };

// GET /tasks/:id/invitations  (manager)
export type TaskInvitationRow = {
  providerProfileId: string; displayName: string; headline: string | null; status: string; invitedAt: string;
  quoteId: string | null; quoteStatus: string | null;
};

// GET /tasks/:id/quotes  (manager sees every submitted quote; a provider sees their own)
export type QuoteRow = {
  id: string; taskId: string; providerProfileId: string; providerName: string; status: string; latestVersion: number;
  latest: { version: number; currency: string; totalMinor: number; notes: string | null; exclusions: string | null; submittedAt: string | null } | null;
};

// GET /tasks/:id/messages
export type ThreadMessage = { id: string; text: string; senderName: string; createdAt: string; mine: boolean };

// GET /notifications
export type NotificationRow = { id: string; kind: string; payload: Record<string, unknown>; createdAt: string; readAt: string | null };

// GET /projects/:id/changes
export type ChangeRow = {
  id: string; title: string; description: string | null; status: string; financialEffect: string; costDeltaMinor: number; currency: string;
  scheduleDeltaDays: number; baseBaselineVersion: number; resultingBaselineVersion: number | null; proposerName: string; taskIds: string[];
  youCanRespond: boolean; youCanWithdraw: boolean; createdAt: string;
};

// GET /projects/:id/reviews
export type ReviewableProvider = { providerProfileId: string; displayName: string; reviewed: boolean };

export type Milestone = {
  id: string; projectId: string; assignmentId: string | null; title: string; amountMinor: number; currency: string;
  dueAt: string | null; acceptanceCriteria: string | null; approverUserId: string | null; status: string; position: number;
  approvedAt: string | null;
};
export type Award = {
  assignmentId: string; status: string; task: { id: string; title: string }; providerName: string;
  agreedMinor: number; currency: string; plannedMinor: number; remainingMinor: number;
};
export type PaymentView = { id: string; milestoneId: string | null; state: string; amountMinor: number; currency: string; releasedMinor: number; createdAt: string };
