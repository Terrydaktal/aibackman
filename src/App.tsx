import { useEffect, useState } from 'react';
import type { AgentAccount } from './types';
import { ArchiveHome, type ArchiveNavigationTarget } from './features/home/ArchiveHome';
import { ChatWorkspace } from './features/chat/ChatWorkspace';
import './index.css';

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 20;
const FONT_SIZE_DEFAULT = 12;
const clampFontSize = (value: number) => Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(value)));

type AppRoute =
  | { kind: 'home' }
  | { kind: 'account'; account: AgentAccount; target?: ArchiveNavigationTarget };

function App() {
  const [route, setRoute] = useState<AppRoute>({ kind: 'home' });

  useEffect(() => {
    const rawFont = Number(localStorage.getItem('fontSize'));
    const fontSize = Number.isFinite(rawFont) && rawFont > 0 ? clampFontSize(rawFont) : FONT_SIZE_DEFAULT;
    const chatWidth = Number(localStorage.getItem('chatWidth')) || 800;
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}pt`);
    document.documentElement.style.setProperty('--message-max-width', `${chatWidth}px`);
  }, []);

  if (route.kind === 'home') {
    return (
      <ArchiveHome
        onOpenAccount={(account, target) => setRoute({ kind: 'account', account, target })}
      />
    );
  }

  return (
    <ChatWorkspace
      key={route.account.id}
      account={route.account}
      initialConversationId={route.target?.conversationId}
      initialMessageId={route.target?.messageId}
      initialSearchQuery={route.target?.query}
      onGoHome={() => setRoute({ kind: 'home' })}
    />
  );
}

export default App;
