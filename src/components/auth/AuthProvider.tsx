"use client";

import { createContext, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";

export interface AuthContextValue {
  user: User | undefined;
  loading: boolean;
  // Sign the current user out. `onAuthStateChanged` then fires with `null`,
  // clearing `user`, at which point `AuthGate` redirects to `/sign-in`.
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: undefined,
  loading: true,
  signOut: () => Promise.resolve(),
});

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getClientAuth(), (firebaseUser) => {
      setUser(firebaseUser ?? undefined);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signOut = (): Promise<void> => firebaseSignOut(getClientAuth());

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
