export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  last_synced_updated_at?: number | null;
  current_node_id?: string | null;
  is_deleted_on_web?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata_json?: string | null;
  created_at: number;
  parent_id?: string;
}

export interface AgentCapabilities {
  importBackup: boolean;
  liveSync: boolean;
  send: boolean;
  cacheAll: boolean;
  localBackup: boolean;
  readOnly: boolean;
}

export interface AccountStats {
  conversationCount: number;
  messageCount: number;
  cachedCount: number;
  latestUpdatedAt: number | null;
}

export interface AgentAccount {
  id: string;
  agentId: string;
  agentName: string;
  agentAccent: string;
  label: string;
  sourceKind: 'live' | 'backup' | 'local';
  sourceConfig: Record<string, unknown>;
  legacyMode: string | null;
  isDefault: boolean;
  capabilities: AgentCapabilities;
  stats?: AccountStats;
}

export interface AgentOverview {
  id: string;
  name: string;
  description: string;
  accent: string;
  capabilities: Record<string, boolean>;
  accounts: AgentAccount[];
}

export interface ArchiveOverview {
  agents: AgentOverview[];
  totals: { accounts: number; conversations: number; messages: number };
}

export interface GlobalSearchResult {
  id: string;
  conversation_id: string;
  conversation_title: string;
  role: string;
  content: string;
  account_id: string;
  account_label: string;
  agent_id: string;
  agent_name: string;
  agent_accent: string;
}

// Electron IPC is a dynamic process boundary. Provider-specific callers narrow
// responses immediately after invocation, while this bridge retains compatibility
// with the existing channel API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcValue = any;

type IpcListener = (...args: IpcValue[]) => void;

export interface ElectronAPI {
  debugEnabled?: boolean;
  invoke: (channel: string, ...args: IpcValue[]) => Promise<IpcValue>;
  onCacheProgress?: (func: IpcListener) => (() => void) | void;
  onBridgeComposerStatus?: (func: IpcListener) => (() => void) | void;
  onArchiveChanged?: (func: IpcListener) => (() => void) | void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
