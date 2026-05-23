export const SIGN_UP_COPY = {
  title: "Create an account",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  passwordLabel: "Password",
  submitButton: "Create account",
  signInPrompt: "Already have an account?",
  signInLink: "Sign in",
  errors: {
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-email": "Please enter a valid email address.",
    default: "Something went wrong. Please try again.",
  },
} as const;
