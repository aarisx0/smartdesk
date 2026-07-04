import React, { createContext, useContext } from 'react';
import { useChat } from '../hooks/useChat';

// Keep the context type separate so Fast Refresh doesn't flag the component
type ChatContextValue = ReturnType<typeof useChat>;

const ChatContext = createContext<ChatContextValue | null>(null);

// Only component export in this file — required for Vite Fast Refresh
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used inside <ChatProvider>');
  return ctx;
}
