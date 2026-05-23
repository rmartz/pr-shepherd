export const FORGOT_PASSWORD_COPY = {
  title: "Reset your password",
  description: "Enter your email and we'll send you a reset link.",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  submitButton: "Send reset link",
  successMessage: "Check your email for a password reset link.",
  signInLink: "Back to sign in",
  errors: {
    "auth/user-not-found": "No account found with that email.",
    "auth/invalid-email": "Please enter a valid email address.",
    default: "Something went wrong. Please try again.",
  },
} as const;
