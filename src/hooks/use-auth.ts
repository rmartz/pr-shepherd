"use client";

import { useContext } from "react";
import {
  AuthContext,
  type AuthContextValue,
} from "@/components/auth/AuthProvider";

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
