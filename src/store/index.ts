import { configureStore } from "@reduxjs/toolkit";

export const store = configureStore({
  reducer: (state: Record<string, never> = {}) => state,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
