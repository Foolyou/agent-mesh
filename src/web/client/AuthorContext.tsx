import { createContext, useContext } from "react";

export interface AuthorRef {
  agent: string;
  meshId: string;
}

export const AuthorContext = createContext<AuthorRef | undefined>(undefined);

export function useAuthor(): AuthorRef | undefined {
  return useContext(AuthorContext);
}
